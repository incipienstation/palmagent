import { useMemo, useRef } from "react";
import type { Repo, TaskState } from "@palmagent/shared";
import { Folder, Plus, Search } from "lucide-react";
import type { ConnState } from "../hooks/useInbox";
import { useRepos } from "../hooks/useRepos";
import { useActionState } from "../action-state";
import { useUpdateState } from "../update-state";
import { compactActivityTime } from "../format";
import { cn } from "../lib/utils";
import { navigate } from "../router";
import { spaceActivities, spaceActivitySummary, spacePath, spaceQualifier, type SpaceActivity } from "../space-context";

import { AppBar, AppShell } from "./AppShell";
import { EmptyState } from "./EmptyState";
import { PullToRefresh } from "./PullToRefresh";
import { RepoPicker } from "./RepoPicker";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { ListSearch } from "./ListSearch";
import { Skeleton } from "./ui/skeleton";

export function SpacesView({ tasks, conn, loading, onRefresh }: { tasks: TaskState[]; conn: ConnState; loading: boolean; onRefresh: () => Promise<void> }) {
  const { repos, loading: reposLoading, error, refresh, refreshing } = useRepos();
  const [query, setQuery] = useActionState("spaces:query", "");
  const [adding, setAdding] = useUpdateState("spaces:adding", false);
  const searchRef = useRef<HTMLInputElement>(null);
  // Freeze the initial activity order while browsing; live counters can update
  // without moving the row under a pointer. Newly connected Spaces append.
  const order = useRef<string[]>([]);
  const activities = useMemo(() => spaceActivities(tasks), [tasks]);
  const rows = useMemo(() => {
    const sorted = [...repos.values()].sort((a, b) => (activities.get(b.id)?.latest ?? 0) - (activities.get(a.id)?.latest ?? 0) || a.name.localeCompare(b.name));
    if (loading) return sorted;
    for (const repo of sorted) if (!order.current.includes(repo.id)) order.current.push(repo.id);
    const positions = new Map(order.current.map((id, index) => [id, index]));
    return sorted.sort((a, b) => (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity));
  }, [repos, activities, loading]);
  const needle = query.trim().toLocaleLowerCase();
  const matches = rows.filter(repo => `${repo.name} ${repo.path}`.toLocaleLowerCase().includes(needle));
  const pending = reposLoading;
  const clear = () => { setQuery(""); searchRef.current?.focus(); };
  return <AppShell>
    <AppBar title="Spaces" conn={conn}>
      <Button variant="secondary" className="rounded-full" onClick={() => setAdding(true)}><Plus data-icon="inline-start" />Add Space</Button>
    </AppBar>
    <div className="flex min-h-0 flex-1 flex-col">
      <ListSearch inputRef={searchRef} label="Search Spaces" clearLabel="Clear Space search" placeholder="Search Spaces…" value={query} onChange={setQuery} />
      <PullToRefresh className="min-h-0 flex-1" scrollKey={!pending ? `spaces:${query}` : undefined} onRefresh={async () => { await Promise.all([onRefresh(), refresh()]); }}>
      <div className="flex flex-col gap-4 px-4 pt-2 pb-4 md:px-6">
        {error && <Alert variant="destructive"><p>{error}</p><Button variant="outline" disabled={refreshing} onClick={() => void refresh().catch(() => {})}>Retry</Button></Alert>}
        {pending ? <div aria-label="Loading Spaces" aria-busy="true" className="flex flex-col">
          {[0, 1, 2].map(i => <div key={i} className="flex min-h-14 items-center gap-3 px-2"><Skeleton className="size-8 rounded-lg" /><Skeleton className="h-4 w-1/3" /><Skeleton className="ml-auto h-3 w-8" /></div>)}
        </div> : <>
          {matches.length > 0 && <section aria-label="Spaces list">
            {needle && <p role="status" className="px-2 pb-1 text-xs text-muted-foreground">
              {matches.length} {matches.length === 1 ? "match" : "matches"}
            </p>}
            <ul className="divide-y divide-border/60">
              {matches.map(repo => <li key={repo.id}><SpaceRow repo={repo} activity={activities.get(repo.id)} loading={loading}
                qualifier={spaceQualifier(repo, repos) ?? (needle && !repo.name.toLocaleLowerCase().includes(needle) ? repo.path : undefined)} /></li>)}
            </ul>
          </section>}
          {!matches.length && !error && <EmptyState icon={needle ? Search : Folder} title={needle ? "No Spaces found" : "Connect your first Space"}
            subtitle={needle ? "Try another name or folder." : "Connect a folder to start working with Palmagent."}
            action={needle ? { label: "Clear search", onClick: clear } : { label: "Add Space", onClick: () => setAdding(true) }} />}
        </>}
      </div>
      </PullToRefresh>
    </div>
    <RepoPicker open={adding} repos={[...repos.values()]} onClose={() => setAdding(false)}
      onRegistered={repo => { setAdding(false); navigate(spacePath(repo.id)); }} onChanged={() => void refresh().catch(() => {})} />
  </AppShell>;
}

function SpaceRow({ repo, activity, loading, qualifier }: { repo: Repo; activity?: SpaceActivity; loading: boolean; qualifier?: string }) {
  const summary = loading ? "" : spaceActivitySummary(activity);
  const latest = activity?.latest;
  return <Button variant="ghost" className="h-auto min-h-14 w-full justify-start gap-3 rounded-lg px-2 py-2 text-left" onClick={() => navigate(spacePath(repo.id))}>
    <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Folder /></span>
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="line-clamp-2 whitespace-normal break-words text-[15px] leading-5">{repo.name}</span>
      {qualifier && <span className="truncate text-xs font-normal text-muted-foreground" title={repo.path}>{qualifier}</span>}
      {summary && <span className={cn("whitespace-normal text-xs font-normal text-muted-foreground", activity?.attention && "text-status-approval-fg")}>{summary}</span>}
    </span>
    {loading ? <Skeleton className="h-3 w-8" aria-label="Loading recent activity" /> : latest ? <time className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground"
      dateTime={new Date(latest).toISOString()} title={new Date(latest).toLocaleString()}><span className="sr-only">Last active </span>{compactActivityTime(latest, { ago: true })}</time> : null}
  </Button>;
}
