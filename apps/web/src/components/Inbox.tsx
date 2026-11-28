import { Pending } from "@/components/ui/spinner";
import { queueTaskArchive, useTaskMutations } from "../task-mutations";
import { useToastObstacle } from "../hooks/useToastObstacle";
import { isActiveTaskStatus, needsTaskAttention, type Repo, type TaskState, type TaskStatus } from "@palmagent/shared";
import { Archive, Check, ChevronRight, Inbox as InboxIcon, Search, Folder, FolderOpen, Pin, Plus } from "lucide-react";
import { createContext, memo, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { useStoredPreference } from "../hooks/useStoredPreference";
import { Skeleton } from "@/components/ui/skeleton";
import { ListSearch } from "./ListSearch";
import { cn } from "@/lib/utils";
import { compareTasks } from "@/lib/task-order";
import { taskTitle } from "@/lib/task-title";
import { statusLabel, statusSection } from "@/lib/status";
import type { ConnState } from "../hooks/useInbox";
import { useRepos } from "../hooks/useRepos";

import { goBackTo, navigate } from "../router";
import { AppBar, AppShell, ConnPill } from "./AppShell";
import { StatusBadge } from "./chips";
import { SpaceDetails, TaskFilterChips, TaskFilters, taskFilterDirectories, type TaskFilter } from "./SpaceTools";
import { useActionState } from "../action-state";
import { Alert } from "./ui/alert";
import { EmptyState } from "./EmptyState";
import { PrChip } from "./PrChip";
import { PullToRefresh } from "./PullToRefresh";
import { SessionActionsMenu } from "./SessionActionsMenu";
import { SwipeToArchive } from "./SwipeToArchive";
import { DropdownMenuItem } from "./ui/dropdown-menu";
import { newTaskPath, spacePath, spaceQualifier, taskDirectoryFor } from "../space-context";

// Resolve Space group headings from the shared repository snapshot.
const ReposContext = createContext<Map<string, Repo>>(new Map());

// Attention-ordered grouping. Every status the backend can emit is represented
// Empty groups stay out of the way; every non-empty state remains reachable.
type InboxStatus = TaskStatus | "local";
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
function taskPriority(task: TaskState): number {
  return GROUP_ORDER.indexOf(task.sessionControl && (task.sessionControl.owner === "local" || task.sessionControl.owner === "returning") ? "local" : task.status);
}
// Match the displayed state: local or disconnected sessions cannot be answered here.
function needsResponse(task: TaskState): boolean {
  const control = task.sessionControl;
  return needsTaskAttention(task.status) && (!control || control.owner === "palmagent"
    || control.owner === "shared" && control.connection === "connected");
}
type Grouping = "status" | "space";
const groupingPreference = "pref:mobile-task-grouping";
function readGrouping(): Grouping {
  try { return localStorage.getItem(groupingPreference) === "space" ? "space" : "status"; }
  catch { return "status"; }
}

const MOBILE_STATUS_ORDER = [
  "Working", "Queued", "Local shell", "Live preview", "Reconnecting", "Sync issue",
  "Failed", "Stopped", "Done", "Cancelled", "Archived",
];

function requestPreview(task: TaskState) {
  if (!needsResponse(task)) return;
  if (task.status === "awaiting_input") return task.pendingInput?.questions[0]?.question;
  return task.pendingApproval?.reason?.trim() || task.pendingApproval?.tool;
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

// A single quiet metadata line; provider and prompt remain in task details.
function TaskMeta({ task, spaceLabel, showState }: { task: TaskState; spaceLabel?: string; showState: boolean }) {
  const done = statusLabel(task.status, task.interrupted, task.sessionControl) === "Done";
  const state = done ? <span className="inline-flex shrink-0 items-center gap-1.5"><Check aria-hidden="true" className="size-3.5" />Done</span>
    : <StatusBadge status={task.status} interrupted={task.interrupted} sessionControl={task.sessionControl} />;
  const prs = task.prs?.length ? <PrChip prs={task.prs} subtle /> : null;
  const time = <time className="shrink-0" dateTime={new Date(task.lastActivityAt).toISOString()}>{relTime(task.lastActivityAt)}</time>;
  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      {spaceLabel ? <div className="flex w-full min-w-0 items-center gap-2">
        {showState && <>{state}<span aria-hidden="true">·</span></>}
        <span className="min-w-0 flex-1 truncate" title={spaceLabel}>{spaceLabel}</span>
        {!showState && prs}
        {time}
      </div> : state}
      {showState && prs && <>{!spaceLabel && <span aria-hidden="true">·</span>}{prs}</>}
      {!spaceLabel && <><span aria-hidden="true">·</span>{time}</>}
    </div>
  );
}

// Titles lead each row; state remains available in the metadata line.
function CardHeadline({ task }: { task: TaskState }) {
  return (
    <div className="flex items-start gap-2 pr-10">
      {task.pinnedAt !== undefined && <Pin className="mt-1 size-4 shrink-0 text-muted-foreground" role="img" aria-label="Pinned" />}
      <span className="min-w-0 flex-1 truncate text-base leading-6 font-medium text-strong">
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

// One compact row treatment for every state; attention stays explicit in metadata.
const TaskRow = memo(function TaskRow({ task, showSpace, hideState, preview }: { task: TaskState; showSpace: boolean; hideState: boolean; preview: boolean }) {
  const repos = useContext(ReposContext);
  const repo = showSpace ? repos.get(task.repoId) : undefined;
  const qualifier = repo ? spaceQualifier(repo, repos) : undefined;
  const spaceLabel = showSpace ? [qualifier, repo?.name ?? "Unavailable Space"].filter(Boolean).join(" · ") : undefined;
  const summary = preview ? requestPreview(task) : undefined;
  const pending = useTaskMutations().get(task.taskId)?.pending;
  const canArchive = !pending && !isActiveTaskStatus(task.status) && task.status !== "archived"
    && (!task.sessionControl || task.sessionControl.owner === "palmagent"
      || task.sessionControl.owner === "shared" && task.sessionControl.connection === "connected")
    && task.messageQueue?.compaction?.status !== "running";
  const archive = () => queueTaskArchive(task.taskId);
  return (
    <SwipeToArchive disabled={!canArchive} onArchive={archive}>
      <div className="relative">
        <button
          data-swipe-surface=""
          className="block w-full px-4 py-3 text-left outline-none transition-colors focus-visible:inset-ring-2 focus-visible:inset-ring-ring active:bg-accent"
          onClick={(e) => navIfInRow(e, task.taskId)}
        >
          <CardHeadline task={task} />
          {summary && <div className="mt-0.5 line-clamp-2 break-words pr-8 text-sm">{summary}</div>}
          <TaskMeta task={task} spaceLabel={spaceLabel} showState={!hideState} />
        </button>
        <div className="absolute top-2 right-1">
          <SessionActionsMenu task={task} label={`Actions for ${taskTitle(task)}`} lifecycle={
            <DropdownMenuItem disabled={!canArchive} onSelect={archive}><Archive />Archive</DropdownMenuItem>
          } />
        </div>
      </div>
    </SwipeToArchive>
  );
});

function TaskGroup({ preferenceKey, label, accessibleName = label, description, tasks, showSpace = false, attention = false, hideState = false, preview = false, actions }: {
  label: string;
  preferenceKey?: string;
  accessibleName?: string;
  description?: string;
  tasks: TaskState[];
  showSpace?: boolean;
  attention?: boolean;
  hideState?: boolean;
  preview?: boolean;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(() => {
    try { return !preferenceKey || localStorage.getItem(preferenceKey) !== "collapsed"; }
    catch { return true; }
  });
  function toggle(next: boolean) {
    setOpen(next);
    if (!preferenceKey) return;
    try {
      if (next) localStorage.removeItem(preferenceKey);
      else localStorage.setItem(preferenceKey, "collapsed");
    } catch { /* Keep the header usable when storage is unavailable. */ }
  }
  if (!tasks.length) return null;
  return <Collapsible asChild open={open} onOpenChange={toggle}>
    <section aria-label={accessibleName} className="overflow-clip border-t bg-card last:border-b md:mx-4 md:rounded-2xl md:border">
      <div className="sticky top-0 z-10 flex items-center bg-muted">
        <h2 className="min-w-0 flex-1">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="h-auto min-h-11 w-full justify-start rounded-none px-4 py-1 text-left">
              <ChevronRight aria-hidden="true" className="text-muted-foreground group-aria-expanded/button:rotate-90" />
              {attention && <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-amber" />}
              <span className="min-w-0">
                <span className="flex items-center gap-1.5">
                  <span className="truncate">{label}</span>
                  <span className="shrink-0 text-muted-foreground">· {tasks.length}</span>
                </span>
                {description && <span className="block truncate text-xs font-normal text-muted-foreground">{description}</span>}
              </span>
            </Button>
          </CollapsibleTrigger>
        </h2>
        {actions && <div className="flex shrink-0 items-center gap-1 pr-2">{actions}</div>}
      </div>
      <CollapsibleContent className="divide-y divide-border/60 border-t">
        {tasks.map(task => <TaskRow key={task.taskId} task={task} showSpace={showSpace} hideState={hideState} preview={preview} />)}
      </CollapsibleContent>
    </section>
  </Collapsible>;
}

function SpaceTaskGroup({ repoId, tasks, preview, preferenceKey }: { preferenceKey?: string; repoId: string; tasks: TaskState[]; preview: boolean }) {
  const repos = useContext(ReposContext);
  const repo = repos.get(repoId);
  const name = repo?.name ?? "Unavailable Space";
  const qualifier = repo ? spaceQualifier(repo, repos) : undefined;
  const label = qualifier ? `${name} · ${qualifier}` : name;
  return <TaskGroup preferenceKey={preferenceKey} label={name} accessibleName={`${label} tasks`} description={qualifier} tasks={tasks} preview={preview}
    actions={repo && <>
      <Button variant="ghost" size="icon-lg" aria-label={`Open Space ${label}`} title={`Open Space ${label}`}
        onClick={() => navigate(spacePath(repoId))}><FolderOpen /></Button>
      <Button variant="ghost" size="icon-lg" aria-label={`New task in ${label}`} title={`New task in ${label}`}
        onClick={() => navigate(newTaskPath(repoId))}><Plus /></Button>
    </>} />;
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
  const [desktop, setDesktop] = useState(() => window.matchMedia("(min-width: 768px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const update = () => setDesktop(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
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
  const [grouping, setGrouping] = useStoredPreference(groupingPreference, readGrouping);
  const mobileHome = !repoId && !desktop;
  const mode = repoId ? "scoped" : desktop ? "desktop" : grouping;
  const [query, setQuery] = useActionState(`inbox:${scopeKey}:query`, "");
  const [directory, setDirectory] = useActionState(`inbox:${scopeKey}:directory`, "all");
  const [statusFilter, setStatusFilter] = useActionState<TaskFilter>(`inbox:${scopeKey}:status`, "all");
  const searchInput = useRef<HTMLInputElement>(null);
  const search = query.trim().toLocaleLowerCase();
  const scoped = repoId ? tasks.filter(task => task.repoId === repoId) : tasks;
  const filterTrigger = useRef<HTMLButtonElement>(null);
  const filters = {
    trigger: filterTrigger, repo: space, directories: taskFilterDirectories(space, repos, scoped, directory),
    directory, onDirectoryChange: setDirectory, status: statusFilter, onStatusChange: setStatusFilter,
  };
  const filtered = scoped.filter(task =>
    (!repoId || directory === "all" || taskDirectoryFor(task, repos) === directory)
    && (statusFilter === "all" || (statusFilter === "local" ? task.sessionControl && (task.sessionControl.owner === "local" || task.sessionControl.owner === "returning") : task.status === statusFilter))
    && (!search || `${taskTitle(task)} ${task.prompt} ${repos.get(task.repoId)?.name ?? ""}`.toLocaleLowerCase().includes(search)));
  const clearSearch = () => { setQuery(""); searchInput.current?.focus(); };
  const groups = new Map<string, TaskState[]>();
  const attentionTasks: TaskState[] = [];
  const pinnedTasks: TaskState[] = [];
  for (const task of filtered) {
    if ((mode === "desktop" || mode === "status") && needsResponse(task)) {
      attentionTasks.push(task);
      continue;
    }
    if (task.pinnedAt !== undefined) {
      pinnedTasks.push(task);
      continue;
    }
    let key = task.repoId;
    if (mode === "status") key = statusLabel(task.status, task.interrupted, task.sessionControl);
    if (mode === "scoped") key = GROUP_ORDER[taskPriority(task)];
    const group = groups.get(key) ?? [];
    group.push(task);
    groups.set(key, group);
  }
  attentionTasks.sort(compareTasks);
  pinnedTasks.sort(compareTasks);
  for (const group of groups.values()) {
    group.sort((a, b) => {
      if (mode === "space") {
        const priority = Number(needsResponse(b)) - Number(needsResponse(a));
        if (priority) return priority;
      }
      if (mode === "desktop" || mode === "space")
        return taskPriority(a) - taskPriority(b) || compareTasks(a, b);
      return compareTasks(a, b);
    });
  }
  // Establish the order from the full snapshot, not search/filter results. Keep
  // live updates from moving a Space under a pointer; new Spaces append.
  const [spaceOrder, setSpaceOrder] = useActionState<string[]>("inbox:space-order", []);
  useEffect(() => {
    if (repoId || loading) return;
    const ids = [...new Set(tasks.slice().sort((a, b) => taskPriority(a) - taskPriority(b) || compareTasks(a, b)).map(task => task.repoId))];
    const added = ids.filter(id => !spaceOrder.includes(id));
    if (added.length) setSpaceOrder([...spaceOrder, ...added]);
  }, [tasks, repoId, loading, spaceOrder, setSpaceOrder]);
  const groupOrder: readonly string[] = mode === "status" ? MOBILE_STATUS_ORDER : mode === "scoped" ? GROUP_ORDER : spaceOrder;
  const orderedGroups = [...groups].sort(([a], [b]) => groupOrder.indexOf(a) - groupOrder.indexOf(b));

  // Search results start open and never overwrite browsing preferences.
  const groupPreference = (group: string) => search ? undefined : `pref:task-group:${JSON.stringify([repoId, group])}`;
  const isEmpty = !loading && filtered.length === 0;
  const selectedName = space?.name ?? "Space";
  const missingSpace = !!repoId && reposLoaded && !space;
  const newTask = () => navigate(newTaskPath(repoId));

  return (
    <ReposContext.Provider value={repos}>
      <AppShell wide>
        <AppBar title={repoId ? selectedName : "Tasks"} back={!!repoId} onBack={() => goBackTo("/spaces")}
          conn={mobileHome ? undefined : conn}>
          {!loading && <TaskFilters {...filters} />}
          {space ? <SpaceDetails repo={space} /> : <Button variant="ghost" size="icon-lg" aria-label="Open Spaces" onClick={() => navigate("/spaces")}><Folder /></Button>}
        </AppBar>
        {mobileHome && conn === "reconnecting" && <div role="status" className="px-4 pb-2"><ConnPill conn={conn} /></div>}
        {archiving && <p role="status" className="px-4 py-2 text-xs text-muted-foreground"><Pending>Archiving task…</Pending></p>}
        <div className="relative flex min-h-0 flex-1 flex-col">
        <ListSearch inputRef={searchInput} label="Search tasks" clearLabel="Clear task search"
          placeholder={repoId ? `Search tasks in ${selectedName}…` : "Search all tasks…"} value={query} onChange={setQuery} action={
            <Button type="button" size="icon-lg" className="size-12 shrink-0 rounded-full"
              ref={desktop || mobileHome ? undefined : toastObstacle} aria-label="Dispatch new task" title="New task" onClick={newTask}
              disabled={!!repoId && (!space || reposLoading)}><Plus /></Button>
          } />
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <PullToRefresh scrollKey={!loading && repos.size ? `inbox:${scopeKey}:${mode}:${directory}:${statusFilter}:${query}` : undefined} className={cn("min-h-0 min-w-0 flex-1 [&_[data-radix-scroll-area-viewport]]:scroll-pt-14",
          mobileHome && "[&_[data-radix-scroll-area-viewport]]:scroll-pb-16")} onRefresh={async () => { await Promise.all([onRefresh(), refresh()]); }}>
          <div data-testid="inbox-content" className={mobileHome ? "pb-16" : "pb-4"}>
            {reposError && <Alert variant="destructive" className="mx-4 mt-3 w-auto">{reposError}<Button variant="outline" onClick={() => void refresh().catch(() => {})}>Retry</Button></Alert>}
            {missingSpace && <Alert className="mx-4 mt-3 w-auto">This Space is no longer connected. Choose another Space to start a task.<Button variant="outline" onClick={() => navigate("/spaces")}>Open Spaces</Button></Alert>}
            {!loading && (search || statusFilter !== "all" || (repoId && directory !== "all")) && <div className="flex flex-col gap-2 px-4 pt-2">
              <TaskFilterChips {...filters} />
              <p role="status" className="text-xs text-muted-foreground">{filtered.length} {filtered.length === 1 ? "task" : "tasks"} found</p>
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
              <div key={JSON.stringify([repoId, mode, search])} className="mt-3 flex flex-col max-md:first:mt-0 md:gap-3">
                <TaskGroup preferenceKey={groupPreference("attention")} label="Needs you" tasks={attentionTasks} showSpace attention preview={mobileHome} />
                <TaskGroup preferenceKey={groupPreference("pinned")} label="Pinned" accessibleName="Pinned tasks" tasks={pinnedTasks} showSpace={!repoId} preview={mobileHome} />
                {orderedGroups.map(([key, group]) => {
                  if (mode === "space" || mode === "desktop")
                    return <SpaceTaskGroup key={key} preferenceKey={groupPreference(`space:${key}`)} repoId={key} tasks={group} preview={mobileHome} />;
                  return <TaskGroup key={key} preferenceKey={groupPreference(`status:${key}`)} label={mode === "scoped" ? statusSection(key as InboxStatus) : key}
                    tasks={group} showSpace={mobileHome} hideState={mobileHome} />;
                })}
              </div>
            )}
          </div>
        </PullToRefresh>
        {mobileHome && <ToggleGroup ref={toastObstacle} type="single" variant="floating" aria-label="Group tasks by"
          className="absolute bottom-0 left-1/2 z-20 -translate-x-1/2" value={grouping}
          onValueChange={value => { if (value === "status" || value === "space") setGrouping(value); }}>
          <ToggleGroupItem value="status">Status</ToggleGroupItem>
          <ToggleGroupItem value="space">Space</ToggleGroupItem>
        </ToggleGroup>}
        </div>
        </div>
      </AppShell>
    </ReposContext.Provider>
  );
});
