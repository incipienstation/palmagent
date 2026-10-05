import { useTaskMutations } from "../task-mutations";
import { useToastObstacle } from "../hooks/useToastObstacle";
import { type Repo, type TaskState, type TaskStatus } from "@palmagent/shared";
import { ChevronDown, Inbox as InboxIcon, SquarePen, Search, Folder, Pin } from "lucide-react";
import { createContext, memo, useContext, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ListSearch } from "./ListSearch";
import { compareTasks } from "@/lib/task-order";
import { taskTitle } from "@/lib/task-title";
import { statusSection } from "@/lib/status";
import { cn } from "@/lib/utils";
import type { ConnState } from "../hooks/useInbox";
import { useRepos } from "../hooks/useRepos";

import { goBackTo, navigate } from "../router";
import { AppBar, AppShell } from "./AppShell";
import { AgentTag, RepoChip, StatusBadge } from "./chips";
import { SpaceDetails, TaskFilters, type TaskFilter } from "./SpaceTools";
import { useActionState } from "../action-state";
import { Alert } from "./ui/alert";
import { Badge } from "./ui/badge";
import { EmptyState } from "./EmptyState";
import { PrChip } from "./PrChip";
import { PullToRefresh } from "./PullToRefresh";
import { SessionActionsMenu } from "./SessionActionsMenu";
import { newTaskPath, taskDirectoryFor } from "../space-context";

// repoId → Repo map for the rows, provided once by InboxView so each card can
// resolve its project name without prop-drilling through StatusGroup.
const ReposContext = createContext<Map<string, Repo>>(new Map());
const ShowSpaceContext = createContext(true);

// Attention-ordered grouping. Every status the backend can emit is represented
// Empty groups stay out of the way; every non-empty state remains reachable.
type InboxStatus = TaskStatus | "local";
const collapsedGroups = new Set<InboxStatus>();
const GROUP_ORDER: InboxStatus[] = [
  "awaiting_input",
  "awaiting_approval",
  "running",
  "queued",
  "local",
  "idle",
  "failed",
  "cancelled",
  "archived",
];
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

// Show results and recency here; model, effort, and permissions live in Session details.
function TaskMeta({ task, showTime }: { task: TaskState; showTime?: boolean }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
      {task.sessionControl && task.sessionControl.owner !== "palmagent" && <Badge variant="secondary">{task.sessionControl.owner === "local" ? "Local shell" : "Returning"}</Badge>}
      {/* Full-auto: the agent opens its own PR(s); one links out, several open a sheet. */}
      <PrChip prs={task.prs} />
      {showTime && <span className="ml-auto shrink-0">{relTime(task.lastActivityAt)}</span>}
    </div>
  );
}

// The 1–2 line body under the headline. Returns null when the prompt would only
// repeat the title (the common no-explicit-title case, where taskTitle() already
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

// Secondary context stays below the title: project, state, and agent.
function CardContextLine({ task }: { task: TaskState }) {
  const repos = useContext(ReposContext);
  const showSpace = useContext(ShowSpaceContext);
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 pr-8">
      {showSpace && <RepoChip repo={repos.get(task.repoId)} isolated={!!task.branch} />}
      <span className="flex shrink-0 items-center gap-2">
        <StatusBadge status={task.status} interrupted={task.interrupted} sessionControl={task.sessionControl} />
        <AgentTag agent={task.agent} />
      </span>
    </div>
  );
}

// Titles lead each row; state remains available in the context line.
function CardHeadline({ task }: { task: TaskState }) {
  return (
    <div className="flex items-start gap-2 pr-10">
      {task.pinnedAt !== undefined && <Pin className="mt-1 size-4 shrink-0 text-muted-foreground" role="img" aria-label="Pinned" />}
      <span className="min-w-0 flex-1 line-clamp-2 text-base leading-6 font-medium text-strong [overflow-wrap:anywhere]">
        {taskTitle(task)}
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

// One calm row treatment for every state, with an inline question preview.
const TaskRow = memo(function TaskRow({ task }: { task: TaskState }) {
  const question = task.pendingInput?.questions[0];
  const preview = task.status === "awaiting_input" && question ? question.question : previewOf(task);
  return (
    <div className="relative">
      <button
        className="block w-full px-4 py-3.5 text-left transition-colors active:bg-accent"
        onClick={(e) => navIfInRow(e, task.taskId)}
      >
        <CardHeadline task={task} />
        <CardContextLine task={task} />
        {preview && (
          <div className="mt-1 line-clamp-2 text-sm leading-5 text-muted-foreground [overflow-wrap:anywhere]">
            {preview}
          </div>
        )}
        <TaskMeta task={task} showTime />
      </button>
      <div className="absolute top-2 right-1">
        <SessionActionsMenu task={task} label={`Actions for ${taskTitle(task)}`} />
      </div>
    </div>
  );
});

// Completed tasks can be folded while live work remains visible. Search always
// reveals matching rows, including completed tasks.
function StatusGroup({ status, tasks, searching }: { status: InboxStatus; tasks: TaskState[]; searching: boolean }) {
  const label = statusSection(status);
  const [expanded, setExpanded] = useState(() => !collapsedGroups.has(status));
  const rowsId = useId();
  if (tasks.length === 0) return null;
  const collapsible = status === "idle" && !searching;
  return (
    <section className="px-4 pt-5 first:pt-3">
      {collapsible ? <h2>
        <Button variant="ghost" className="w-full justify-start px-0 text-xs font-medium text-muted-foreground" aria-expanded={expanded} aria-controls={rowsId}
          onClick={() => {
            if (expanded) collapsedGroups.add(status); else collapsedGroups.delete(status);
            setExpanded(!expanded);
          }}>
          {label}<span aria-hidden="true" className="text-muted-foreground">· {tasks.length}</span>
          <ChevronDown aria-hidden="true" className={cn("ml-auto", expanded && "rotate-180")} />
        </Button>
      </h2> : <div className="flex items-center gap-1.5 pb-2 text-xs font-medium text-muted-foreground">
        <h2>{label}</h2><span aria-hidden="true">· {tasks.length}</span>
      </div>}
      <div id={rowsId} hidden={collapsible && !expanded}>
        <div className="-mx-4">
          {tasks.map(task => <TaskRow key={task.taskId} task={task} />)}
        </div>
      </div>
    </section>
  );
}

// Skeleton rows shown while the first SSE snapshot is in flight (the mock
// harness renders loaded state, so these never appear in visual snapshots).
function LoadingRows() {
  return (
    <section className="px-4 pt-3" aria-label="Loading tasks" aria-busy="true">
      <div className="flex items-center gap-2 pb-2 text-xs font-medium text-muted-foreground">
        <span role="status">Loading tasks…</span>
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

export const InboxView = memo(function InboxView({
  tasks,
  conn,
  loading,
  onRefresh,
  repoId,
}: {
  tasks: TaskState[];
  conn: ConnState;
  loading?: boolean;
  onRefresh: () => Promise<void>;
  repoId?: string;
}) {
  const mutations = useTaskMutations();
  const archiving = [...mutations.values()].some(change => change.hidden && change.pending);
  const toastObstacle = useToastObstacle();
  // Project (repo) lookup for the cards. The task snapshot carries only repoId;
  // we join the human-friendly name client-side. If a task references a repo we
  // don't have yet (registered since the last fetch), refetch once — `tried`
  // bounds it to a single attempt per id so a deleted repo can't loop.
  const { repos, refresh, loading: reposLoading, error: reposError, loaded: reposLoaded } = useRepos();
  const tried = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (reposLoading) return;
    const missing = tasks.filter((t) => !repos.has(t.repoId) && !tried.current.has(t.repoId));
    if (missing.length === 0) return;
    for (const t of missing) tried.current.add(t.repoId);
    void refresh().catch(() => {});
  }, [tasks, repos, refresh, reposLoading]);

  const space = repoId ? repos.get(repoId) : undefined;
  const scopeKey = repoId ?? "all";
  const [query, setQuery] = useActionState(`inbox:${scopeKey}:query`, "");
  const [directory, setDirectory] = useActionState(`inbox:${scopeKey}:directory`, "all");
  const [statusFilter, setStatusFilter] = useActionState<TaskFilter>(`inbox:${scopeKey}:status`, "all");
  const searchInput = useRef<HTMLInputElement>(null);
  const search = query.trim().toLocaleLowerCase();
  const scoped = repoId ? tasks.filter(task => task.repoId === repoId) : tasks;
  const filtered = scoped.filter(task =>
    (!repoId || directory === "all" || taskDirectoryFor(task, repos) === directory)
    && (statusFilter === "all" || (statusFilter === "local" ? task.sessionControl && task.sessionControl.owner !== "palmagent" : task.status === statusFilter))
    && (!search || `${taskTitle(task)} ${task.prompt} ${repos.get(task.repoId)?.name ?? ""}`.toLocaleLowerCase().includes(search)));
  const clearSearch = () => { setQuery(""); searchInput.current?.focus(); };
  const byStatus = new Map<InboxStatus, TaskState[]>();
  for (const t of filtered) {
    const group = t.sessionControl && t.sessionControl.owner !== "palmagent" ? "local" : t.status;
    const arr = byStatus.get(group) ?? [];
    arr.push(t);
    byStatus.set(group, arr);
  }
  // Preserve status groups and filters, with stable pins first in each group.
  for (const arr of byStatus.values()) arr.sort(compareTasks);

  const isEmpty = !loading && filtered.length === 0;
  const selectedName = space?.name ?? "Space";
  const missingSpace = !!repoId && reposLoaded && !space;
  const newTask = () => navigate(newTaskPath(repoId));

  return (
    <ReposContext.Provider value={repos}><ShowSpaceContext.Provider value={!repoId}>
      <AppShell wide>
        <AppBar title={repoId ? selectedName : "All spaces"} back={!!repoId} onBack={() => goBackTo("/spaces")} conn={conn}>
          {space ? <SpaceDetails repo={space} /> : <Button variant="ghost" size="icon-lg" aria-label="Open Spaces" onClick={() => navigate("/spaces")}><Folder /></Button>}
        </AppBar>
        {archiving && <p role="status" className="px-4 py-2 text-xs text-muted-foreground">Archiving task…</p>}
        <div className="relative flex min-h-0 flex-1 flex-col">
        <ListSearch inputRef={searchInput} label="Search tasks" clearLabel="Clear task search"
          placeholder={repoId ? `Search tasks in ${selectedName}…` : "Search all tasks…"} value={query} onChange={setQuery} />
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <PullToRefresh scrollKey={!loading && repos.size ? `inbox:${scopeKey}:${directory}:${statusFilter}:${query}` : undefined} className="min-h-0 min-w-0 flex-1" onRefresh={async () => { await Promise.all([onRefresh(), refresh()]); }}>
          {/* Let the final row scroll fully above the floating action. */}
          <div data-testid="inbox-content" className="pb-22">
            {!repoId && <p className="px-4 pt-1 text-sm text-muted-foreground">Tasks across all your Spaces</p>}
            {reposError && <Alert variant="destructive" className="mx-4 mt-3 w-auto">{reposError}<Button variant="outline" onClick={() => void refresh().catch(() => {})}>Retry</Button></Alert>}
            {missingSpace && <Alert className="mx-4 mt-3 w-auto">This Space is no longer connected. Choose another Space to start a task.<Button variant="outline" onClick={() => navigate("/spaces")}>Open Spaces</Button></Alert>}
            {!loading && <div className="flex flex-col gap-3 px-4 pt-2 pb-1">
              <TaskFilters repo={space} repos={repos} tasks={scoped} directory={directory} onDirectoryChange={setDirectory} status={statusFilter} onStatusChange={setStatusFilter} />
              {search && <p role="status" className="pt-2 text-xs text-muted-foreground">{filtered.length} {filtered.length === 1 ? "task" : "tasks"} found</p>}
            </div>}
            {loading ? (
              <LoadingRows />
            ) : isEmpty ? (
              <EmptyState
                icon={search ? Search : InboxIcon}
                title={search ? "No matching tasks" : directory !== "all" || statusFilter !== "all" ? "No tasks match these filters" : "No tasks yet"}
                subtitle={search ? "Try another title or part of a prompt in this scope." : "Start a task and track it here."}
                action={search ? { label: "Clear search", onClick: clearSearch } : directory !== "all" || statusFilter !== "all" ? { label: "Clear filters", onClick: () => { setDirectory("all"); setStatusFilter("all"); } } : missingSpace ? { label: "Open Spaces", onClick: () => navigate("/spaces") } : undefined}
              />
            ) : (
              GROUP_ORDER.filter(status => byStatus.has(status)).map((status) => (
                <StatusGroup key={status} status={status} tasks={byStatus.get(status) ?? []} searching={!!search} />
              ))
            )}
          </div>
        </PullToRefresh>
        <Button
          className="absolute right-4 bottom-5 z-20 h-12 rounded-full px-5 shadow-lg transition-[bottom,transform] duration-200 active:translate-y-0.5"
          ref={toastObstacle}
          aria-label="Dispatch new task"
          onClick={newTask}
          disabled={!!repoId && (!space || reposLoading)}
        >
          <SquarePen className="size-5" />
          New task
        </Button>
        </div>
        </div>
      </AppShell>
    </ShowSpaceContext.Provider></ReposContext.Provider>
  );
});
