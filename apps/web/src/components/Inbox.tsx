import { queueTaskArchive, useTaskMutations } from "../task-mutations";
import { useToastObstacle } from "../hooks/useToastObstacle";
import { isActiveTaskStatus, type Repo, type TaskState, type TaskStatus } from "@palmagent/shared";
import { Archive, Check, Inbox as InboxIcon, Search, Folder, FolderOpen, Pin, Plus } from "lucide-react";
import { createContext, memo, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { Skeleton } from "@/components/ui/skeleton";
import { ListSearch } from "./ListSearch";
import { compareTasks } from "@/lib/task-order";
import { taskTitle } from "@/lib/task-title";
import { statusLabel, statusSection } from "@/lib/status";
import type { ConnState } from "../hooks/useInbox";
import { useRepos } from "../hooks/useRepos";

import { goBackTo, navigate } from "../router";
import { AppBar, AppShell } from "./AppShell";
import { StatusBadge } from "./chips";
import { SpaceDetails, TaskFilters, type TaskFilter } from "./SpaceTools";
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
function taskPriority(task: TaskState): number {
  return GROUP_ORDER.indexOf(task.sessionControl && (task.sessionControl.owner === "local" || task.sessionControl.owner === "returning") ? "local" : task.status);
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
function TaskMeta({ task }: { task: TaskState }) {
  const done = statusLabel(task.status, task.interrupted, task.sessionControl) === "Done";
  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      {done ? <span className="inline-flex shrink-0 items-center gap-1.5"><Check aria-hidden="true" className="size-3.5" />Done</span>
        : <StatusBadge status={task.status} interrupted={task.interrupted} sessionControl={task.sessionControl} />}
      {!!task.prs?.length && <><span aria-hidden="true">·</span><PrChip prs={task.prs} subtle /></>}
      <span aria-hidden="true">·</span>
      <time className="shrink-0" dateTime={new Date(task.lastActivityAt).toISOString()}>{relTime(task.lastActivityAt)}</time>
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
const TaskRow = memo(function TaskRow({ task }: { task: TaskState }) {
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
          className="block w-full px-4 py-3 text-left transition-colors active:bg-accent"
          onClick={(e) => navIfInRow(e, task.taskId)}
        >
          <CardHeadline task={task} />
          <TaskMeta task={task} />
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

// Every task-list section uses the same disclosure. Search and filters reveal
// matches temporarily without replacing the user's saved folding choices.
function TaskGroup({ label, accessibleName = label, description, tasks, collapsed, onCollapsedChange, reveal, actions }: {
  label: string;
  accessibleName?: string;
  description?: string;
  tasks: TaskState[];
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  reveal: boolean;
  actions?: ReactNode;
}) {
  if (tasks.length === 0) return null;
  return (
    <section aria-label={accessibleName} className="px-4 pt-3">
      <Accordion type="single" collapsible={!reveal} value={reveal || !collapsed ? "tasks" : ""}
        onValueChange={value => { if (!reveal) onCollapsedChange(!value); }}>
        <AccordionItem value="tasks">
          <div className="flex min-w-0 items-center">
            <div className="min-w-0 flex-1">
              <AccordionTrigger headingLevel={2} aria-label={accessibleName} className="min-w-0">
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 truncate">{label}</span>
                    <span aria-hidden="true" className="shrink-0 text-muted-foreground">· {tasks.length}</span>
                  </span>
                  {description && <span className="block truncate text-xs text-muted-foreground">{description}</span>}
                </span>
              </AccordionTrigger>
            </div>
            {actions && <div className="flex shrink-0 items-center gap-1 pr-2">{actions}</div>}
          </div>
          <AccordionContent role="group" className="-mx-4 pb-0">
            {tasks.map(task => <TaskRow key={task.taskId} task={task} />)}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </section>
  );
}

function StatusGroup({ status, tasks, reveal }: { status: InboxStatus; tasks: TaskState[]; reveal: boolean }) {
  const [collapsed, setCollapsed] = useState(() => collapsedGroups.has(status));
  return <TaskGroup label={statusSection(status)} tasks={tasks} collapsed={collapsed} reveal={reveal}
    onCollapsedChange={next => {
      if (next) collapsedGroups.add(status); else collapsedGroups.delete(status);
      setCollapsed(next);
    }} />;
}

// Global task groups retain their folded state when visiting a session. A search
// or status filter temporarily reveals every match without changing that state.
function SpaceTaskGroup({ repoId, tasks, reveal }: { repoId: string; tasks: TaskState[]; reveal: boolean }) {
  const repos = useContext(ReposContext);
  const repo = repos.get(repoId);
  const name = repo?.name ?? "Unavailable Space";
  const qualifier = repo ? spaceQualifier(repo, repos) : undefined;
  const label = qualifier ? `${name} · ${qualifier}` : name;
  const [collapsed, setCollapsed] = useActionState(`inbox:space-group:${repoId}:collapsed`, false);
  return <TaskGroup label={name} accessibleName={`${label} tasks`} description={qualifier} tasks={tasks}
    collapsed={collapsed} onCollapsedChange={setCollapsed} reveal={reveal} actions={repo && <>
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
  const [query, setQuery] = useActionState(`inbox:${scopeKey}:query`, "");
  const [directory, setDirectory] = useActionState(`inbox:${scopeKey}:directory`, "all");
  const [statusFilter, setStatusFilter] = useActionState<TaskFilter>(`inbox:${scopeKey}:status`, "all");
  const searchInput = useRef<HTMLInputElement>(null);
  const search = query.trim().toLocaleLowerCase();
  const scoped = repoId ? tasks.filter(task => task.repoId === repoId) : tasks;
  const filtered = scoped.filter(task =>
    (!repoId || directory === "all" || taskDirectoryFor(task, repos) === directory)
    && (statusFilter === "all" || (statusFilter === "local" ? task.sessionControl && (task.sessionControl.owner === "local" || task.sessionControl.owner === "returning") : task.status === statusFilter))
    && (!search || `${taskTitle(task)} ${task.prompt} ${repos.get(task.repoId)?.name ?? ""}`.toLocaleLowerCase().includes(search)));
  const clearSearch = () => { setQuery(""); searchInput.current?.focus(); };
  const byStatus = new Map<InboxStatus, TaskState[]>();
  for (const t of filtered) {
    const group = t.sessionControl && (t.sessionControl.owner === "local" || t.sessionControl.owner === "returning") ? "local" : t.status;
    const arr = byStatus.get(group) ?? [];
    arr.push(t);
    byStatus.set(group, arr);
  }
  // Preserve status groups and filters, with stable pins first in each group.
  for (const arr of byStatus.values()) arr.sort(compareTasks);

  const bySpace = new Map<string, TaskState[]>();
  for (const task of filtered) {
    const group = bySpace.get(task.repoId) ?? [];
    group.push(task);
    bySpace.set(task.repoId, group);
  }
  for (const group of bySpace.values()) group.sort((a, b) =>
    a.pinnedAt !== undefined || b.pinnedAt !== undefined ? compareTasks(a, b) : taskPriority(a) - taskPriority(b) || compareTasks(a, b));
  // Establish the order from the full snapshot, not search/filter results. Keep
  // live updates from moving a Space under a pointer; new Spaces append.
  const [spaceOrder, setSpaceOrder] = useActionState<string[]>("inbox:space-order", []);
  useEffect(() => {
    if (repoId || loading) return;
    const ids = [...new Set(tasks.slice().sort((a, b) => taskPriority(a) - taskPriority(b) || compareTasks(a, b)).map(task => task.repoId))];
    const added = ids.filter(id => !spaceOrder.includes(id));
    if (added.length) setSpaceOrder([...spaceOrder, ...added]);
  }, [tasks, repoId, loading, spaceOrder, setSpaceOrder]);
  const spaceGroups = [...bySpace].sort(([a], [b]) => spaceOrder.indexOf(a) - spaceOrder.indexOf(b));

  const answers = scoped.filter(task => task.status === "awaiting_input").length;
  const approvals = scoped.filter(task => task.status === "awaiting_approval").length;
  const isEmpty = !loading && filtered.length === 0;
  const selectedName = space?.name ?? "Space";
  const missingSpace = !!repoId && reposLoaded && !space;
  const newTask = () => navigate(newTaskPath(repoId));

  return (
    <ReposContext.Provider value={repos}>
      <AppShell wide>
        <AppBar title={repoId ? selectedName : "Tasks"} back={!!repoId} onBack={() => goBackTo("/spaces")} conn={conn}>
          {space ? <SpaceDetails repo={space} /> : <Button variant="ghost" size="icon-lg" aria-label="Open Spaces" onClick={() => navigate("/spaces")}><Folder /></Button>}
        </AppBar>
        {archiving && <p role="status" className="px-4 py-2 text-xs text-muted-foreground">Archiving task…</p>}
        <div className="relative flex min-h-0 flex-1 flex-col">
        <ListSearch inputRef={searchInput} label="Search tasks" clearLabel="Clear task search"
          placeholder={repoId ? `Search tasks in ${selectedName}…` : "Search all tasks…"} value={query} onChange={setQuery} action={
            <Button type="button" size="icon-lg" className="size-12 shrink-0 rounded-full"
              ref={desktop ? undefined : toastObstacle} aria-label="Dispatch new task" title="New task" onClick={newTask}
              disabled={!!repoId && (!space || reposLoading)}><Plus /></Button>
          } />
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <PullToRefresh scrollKey={!loading && repos.size ? `inbox:${scopeKey}:${directory}:${statusFilter}:${query}` : undefined} className="min-h-0 min-w-0 flex-1" onRefresh={async () => { await Promise.all([onRefresh(), refresh()]); }}>
          <div data-testid="inbox-content" className="pb-4">
            {reposError && <Alert variant="destructive" className="mx-4 mt-3 w-auto">{reposError}<Button variant="outline" onClick={() => void refresh().catch(() => {})}>Retry</Button></Alert>}
            {missingSpace && <Alert className="mx-4 mt-3 w-auto">This Space is no longer connected. Choose another Space to start a task.<Button variant="outline" onClick={() => navigate("/spaces")}>Open Spaces</Button></Alert>}
            {!loading && <div className="flex flex-col gap-3 px-4 pt-2 pb-1">
              <TaskFilters repo={space} repos={repos} tasks={scoped} directory={directory} onDirectoryChange={setDirectory} status={statusFilter} onStatusChange={setStatusFilter} />
              {!repoId && (answers > 0 || approvals > 0 || statusFilter === "awaiting_input" || statusFilter === "awaiting_approval") &&
                <ToggleGroup type="single" variant="pills" aria-label="Quick task filters" value={statusFilter}
                  onValueChange={value => setStatusFilter((value || "all") as TaskFilter)}>
                  {(answers > 0 || statusFilter === "awaiting_input") && <ToggleGroupItem variant="pill" value="awaiting_input" aria-label="Needs answer">Answer · {answers}</ToggleGroupItem>}
                  {(approvals > 0 || statusFilter === "awaiting_approval") && <ToggleGroupItem variant="pill" value="awaiting_approval" aria-label="Needs approval">Approval · {approvals}</ToggleGroupItem>}
                </ToggleGroup>}
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
            ) : !repoId ? (
              spaceGroups.map(([id, group]) => <SpaceTaskGroup key={id} repoId={id} tasks={group} reveal={!!search || statusFilter !== "all"} />)
            ) : (
              GROUP_ORDER.filter(status => byStatus.has(status)).map((status) => (
                <StatusGroup key={status} status={status} tasks={byStatus.get(status) ?? []} reveal={!!search || statusFilter !== "all"} />
              ))
            )}
          </div>
        </PullToRefresh>
        </div>
        </div>
      </AppShell>
    </ReposContext.Provider>
  );
});
