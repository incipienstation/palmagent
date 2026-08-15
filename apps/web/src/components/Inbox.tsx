import { type Repo, type TaskState, type TaskStatus } from "@palmagent/shared";
import { Inbox as InboxIcon, Plus } from "lucide-react";
import { createContext, useContext, useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { statusSection } from "@/lib/status";
import { cn } from "@/lib/utils";
import type { ConnState } from "../hooks/useInbox";
import { useRepos } from "../hooks/useRepos";
import { reloadApp } from "../pwa";
import { navigate } from "../router";
import { AppBar, AppShell } from "./AppShell";
import { AgentTag, RepoChip, StatusBadge } from "./chips";
import { EmptyState } from "./EmptyState";
import { PrChip } from "./PrChip";
import { PullToRefresh } from "./PullToRefresh";

// repoId → Repo map for the rows, provided once by InboxView so each card can
// resolve its project name without prop-drilling through StatusGroup.
const ReposContext = createContext<Map<string, Repo>>(new Map());

// Attention-ordered grouping. Every status the backend can emit is represented
// AND every group header is always rendered (empty ones collapse to a faint
// "—"), so nothing silently disappears from the inbox.
const GROUP_ORDER: TaskStatus[] = [
  "awaiting_input",
  "awaiting_approval",
  "running",
  "queued",
  "idle",
  "failed",
  "cancelled",
  "archived",
];
function titleOf(t: TaskState): string {
  if (t.title && t.title.trim()) return t.title;
  const first = t.prompt.split("\n").find((l) => l.trim());
  return first?.trim() || "(untitled task)";
}

// Compact relative time for the row meta line ("3m", "2h", "4d"); falls back to
// a short date past a week so the dense list stays scannable.
function relTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

// Per-status left-rail + faint tinted bg for the priority (awaiting_*) rows.
// Rail color: question-active (input) / amber (approval), per the design spec.
const ATTENTION_RAIL: Partial<Record<TaskStatus, string>> = {
  awaiting_input: "border-l-question-active bg-status-input-bg",
  awaiting_approval: "border-l-amber bg-status-approval-bg",
};

// Quiet footnote tier: the machine knobs (model, effort, permission), the PR
// link, and the time. The project lives in the eyebrow (RepoChip) and the agent
// tag in the context row, so neither is repeated here; the raw `agent/<taskId>`
// branch is gone — the RepoChip's isolation glyph carries that signal instead.
function TaskMeta({ task, showTime }: { task: TaskState; showTime?: boolean }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-faint">
      {task.model && <span>{task.model}</span>}
      {task.effort && <span>effort {task.effort}</span>}
      <span>{task.permission}</span>
      {/* Full-auto: the agent opens its own PR(s); one links out, several open a sheet. */}
      <PrChip prs={task.prs} />
      {showTime && <span className="ml-auto shrink-0">{relTime(task.lastActivityAt)}</span>}
    </div>
  );
}

// The 1–2 line body under the headline. Returns null when the prompt would only
// repeat the title (the common no-explicit-title case, where titleOf() already
// IS the prompt's first line) so the card never shows the same text twice; when
// there's a multi-line prompt it shows the remainder, and an explicit title
// shows the full prompt as added context.
function previewOf(t: TaskState): string | null {
  const prompt = t.prompt.trim();
  if (!prompt) return null;
  if (t.title && t.title.trim()) return prompt === t.title.trim() ? null : prompt;
  const lines = prompt.split("\n");
  const firstIdx = lines.findIndex((l) => l.trim());
  const rest = lines.slice(firstIdx + 1).join("\n").trim();
  return rest || null;
}

// Eyebrow row: the project (left, scannable anchor) and the status + agent
// badges (right). This is the card's "where + what state" line, above the title.
function CardContextLine({ task }: { task: TaskState }) {
  const repos = useContext(ReposContext);
  return (
    <div className="flex items-center gap-2">
      <RepoChip repo={repos.get(task.repoId)} isolated={!!task.branch} />
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        <StatusBadge status={task.status} interrupted={task.interrupted} />
        <AgentTag agent={task.agent} />
      </span>
    </div>
  );
}

// The headline: a live dot for running turns + the task title (up to two lines,
// so a long title-from-prompt reads in full instead of being cut mid-thought).
// The dot pulses — green now means "this task is running" exclusively (the
// header no longer shows a green connected-dot), and the pulse reads as "alive".
function CardHeadline({ task }: { task: TaskState }) {
  return (
    <div className="mt-1 flex items-start gap-2">
      {task.status === "running" && (
        <span aria-hidden className="mt-[6px] size-2 shrink-0 animate-pulse rounded-full bg-live" />
      )}
      <span className="min-w-0 flex-1 line-clamp-2 text-[15px] leading-5 font-semibold text-strong [overflow-wrap:anywhere]">
        {titleOf(task)}
      </span>
    </div>
  );
}

// Tap-to-open the task — but ignore clicks that bubble up from a portaled overlay.
// The PR sheet + its scrim render to <body>, yet React still routes their events
// through this button's React-tree position; their real target isn't inside the
// row, so we skip navigation (tapping the scrim to dismiss the sheet, or a PR row
// inside it, must not also open the task). Real in-row taps still navigate.
function navIfInRow(e: { currentTarget: HTMLElement; target: EventTarget | null }, taskId: string) {
  if (e.target instanceof Node && !e.currentTarget.contains(e.target)) return;
  navigate(`/task/${encodeURIComponent(taskId)}`);
}

// Dense default row: a full-width tappable button with a hairline divider. A
// project eyebrow (+ status/agent badges) sits on top, then the title headline,
// then a deduped prompt snippet (omitted when it would echo the title), then the
// quiet meta line and a relative timestamp.
function TaskRow({ task }: { task: TaskState }) {
  const preview = previewOf(task);
  return (
    <button
      className="block w-full border-b border-border px-4 py-2.5 text-left transition-colors active:bg-accent"
      onClick={(e) => navIfInRow(e, task.taskId)}
    >
      <CardContextLine task={task} />
      <CardHeadline task={task} />
      {preview && (
        <div className="mt-1 line-clamp-2 text-[13px] leading-[18px] text-muted-foreground [overflow-wrap:anywhere]">
          {preview}
        </div>
      )}
      <TaskMeta task={task} showTime />
    </button>
  );
}

// Priority row (awaiting_input / awaiting_approval): a tinted attention Card with
// the inline question teaser so it can be triaged without opening the task. The
// Card is a <div>, so it is wrapped in a full-width <button> for the tap target.
function PriorityRow({ task }: { task: TaskState }) {
  const q = task.pendingInput?.questions[0];
  const preview = previewOf(task);
  return (
    <button
      className="mb-2.5 block w-full text-left"
      onClick={(e) => navIfInRow(e, task.taskId)}
    >
      <Card
        variant="attention"
        className={cn(
          "px-3.5 py-3 transition-colors active:bg-accent",
          ATTENTION_RAIL[task.status],
        )}
      >
        <CardContextLine task={task} />
        <CardHeadline task={task} />
        {task.status === "awaiting_input" && q ? (
          <div className="mt-2 rounded-lg border border-question-border bg-question-bg px-2.5 py-2">
            <div className="text-[11px] font-semibold tracking-wide text-question-fg uppercase">
              🙋 {q.header || "The agent has a question"}
            </div>
            <div className="mt-0.5 line-clamp-2 text-[13px] text-strong [overflow-wrap:anywhere]">
              {q.question}
            </div>
            <div className="mt-1 text-[11px] text-question-fg">Tap to answer →</div>
          </div>
        ) : (
          preview && (
            <div className="mt-1 line-clamp-2 text-[13px] leading-[18px] text-muted-foreground [overflow-wrap:anywhere]">
              {preview}
            </div>
          )
        )}
        <TaskMeta task={task} showTime />
      </Card>
    </button>
  );
}

// One status group, "quiet" style: no section hairline — whitespace + a small
// uppercase eyebrow (LABEL · count) do the grouping, so the section rule never
// competes with the per-row hairlines inside a populated group. Empty groups no
// longer fence off an empty band: they collapse to a single faint "LABEL —" line
// (no divider, tight top space) so every status label is still present and
// nothing silently disappears.
function StatusGroup({ status, tasks }: { status: TaskStatus; tasks: TaskState[] }) {
  const label = statusSection(status);

  if (tasks.length === 0) {
    return (
      <div className="flex items-center gap-1.5 px-4 pt-4 text-[11px] font-semibold tracking-wide text-faint/55 uppercase first:pt-3">
        <h2>{label}</h2>
        <span aria-hidden className="text-faint/35">
          —
        </span>
      </div>
    );
  }

  const priority = status === "awaiting_input" || status === "awaiting_approval";
  return (
    <section className="px-4 pt-7 first:pt-3">
      <div className="flex items-center gap-1.5 pb-2 text-[11px] font-semibold tracking-wide text-faint uppercase">
        <h2>{label}</h2>
        <span aria-hidden className="text-faint/40">
          ·
        </span>
        <span className="text-faint/70 tabular-nums">{tasks.length}</span>
      </div>
      {priority ? (
        tasks.map((t) => <PriorityRow key={t.taskId} task={t} />)
      ) : (
        // Dense rows extend to the screen gutter so the hairline runs edge-to-edge;
        // the last row drops its divider so the group closes cleanly into whitespace.
        <div className="-mx-4 [&>button:last-child]:border-b-0">
          {tasks.map((t) => (
            <TaskRow key={t.taskId} task={t} />
          ))}
        </div>
      )}
    </section>
  );
}

// Skeleton rows shown while the first SSE snapshot is in flight (the mock
// harness renders loaded state, so these never appear in visual snapshots).
function LoadingRows() {
  return (
    <section className="px-4 pt-3">
      <div className="flex items-center gap-2 pb-2 text-[11px] font-semibold tracking-wide text-faint uppercase">
        <span>Loading</span>
      </div>
      <div className="-mx-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="border-b border-border px-4 py-2.5">
            <div className="flex items-center gap-2">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="ml-auto h-5 w-16 rounded-full" />
            </div>
            <Skeleton className="mt-2 h-3 w-4/5" />
            <Skeleton className="mt-2 h-3 w-1/3" />
          </div>
        ))}
      </div>
    </section>
  );
}

export function InboxView({
  tasks,
  conn,
  loading,
}: {
  tasks: TaskState[];
  conn: ConnState;
  /** Reserved for an explicit loading signal; the live stream starts empty so
      App doesn't currently pass it (empty = the EmptyState, not skeletons). */
  loading?: boolean;
}) {
  // Project (repo) lookup for the cards. The task snapshot carries only repoId;
  // we join the human-friendly name client-side. If a task references a repo we
  // don't have yet (registered since the last fetch), refetch once — `tried`
  // bounds it to a single attempt per id so a deleted repo can't loop.
  const { repos, refresh } = useRepos();
  const tried = useRef<Set<string>>(new Set());
  useEffect(() => {
    const missing = tasks.filter((t) => !repos.has(t.repoId) && !tried.current.has(t.repoId));
    if (missing.length === 0) return;
    for (const t of missing) tried.current.add(t.repoId);
    refresh();
  }, [tasks, repos, refresh]);

  const byStatus = new Map<TaskStatus, TaskState[]>();
  for (const t of tasks) {
    const arr = byStatus.get(t.status) ?? [];
    arr.push(t);
    byStatus.set(t.status, arr);
  }
  // Most-recent first within each group.
  for (const arr of byStatus.values()) arr.sort((a, b) => b.lastActivityAt - a.lastActivityAt);

  const attention = tasks.some(
    (t) => t.status === "awaiting_input" || t.status === "awaiting_approval",
  );
  const isEmpty = !loading && tasks.length === 0;

  return (
    <ReposContext.Provider value={repos}>
      <AppShell attention={attention}>
        <AppBar title="Tasks" brand conn={conn} settings />
        <PullToRefresh className="min-h-0 flex-1" onRefresh={reloadApp}>
          {/* The pb wrapper tracks the tab bar + banner + FAB clearance; it is the
              parent of the status <section>s (the inbox FAB/--banner-h contract). */}
          <div className="pb-[calc(var(--tabbar-h,0px)+var(--banner-h,0px)+88px)]">
            {loading ? (
              <LoadingRows />
            ) : isEmpty ? (
              <EmptyState
                icon={InboxIcon}
                title="No tasks yet"
                subtitle="Send your first task to an agent and track it here."
                action={{ label: "Dispatch a task", onClick: () => navigate("/new") }}
              />
            ) : (
              GROUP_ORDER.map((status) => (
                <StatusGroup key={status} status={status} tasks={byStatus.get(status) ?? []} />
              ))
            )}
          </div>
        </PullToRefresh>
        <Button
          size="icon"
          className="fixed right-[max(16px,calc((100vw-720px)/2+16px))] bottom-[calc(20px+var(--safe-bottom)+var(--tabbar-h,0px)+var(--banner-h,0px))] z-20 size-14 rounded-full shadow-[0_10px_28px_-6px_rgba(0,137,123,0.40),0_3px_10px_-4px_rgba(0,0,0,0.18)] transition-[bottom,transform,box-shadow,background-color] duration-200 active:translate-y-0.5 active:shadow-[0_4px_12px_-6px_rgba(0,137,123,0.34),0_2px_6px_-4px_rgba(0,0,0,0.16)] dark:shadow-[0_12px_34px_-6px_rgba(20,184,166,0.50),0_4px_14px_-4px_rgba(0,0,0,0.55)] dark:active:shadow-[0_6px_18px_-6px_rgba(20,184,166,0.40),0_2px_8px_-4px_rgba(0,0,0,0.5)]"
          aria-label="Dispatch new task"
          onClick={() => navigate("/new")}
        >
          <Plus className="size-7" />
        </Button>
      </AppShell>
    </ReposContext.Provider>
  );
}
