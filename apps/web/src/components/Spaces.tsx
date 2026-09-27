import { useMemo, useRef } from "react";
import type { Repo, TaskState } from "@palmagent/shared";
import { ChevronRight, Folder, Layers, Plus, Search, X } from "lucide-react";
import type { ConnState } from "../hooks/useInbox";
import { useRepos } from "../hooks/useRepos";
import { useActionState } from "../action-state";
import { useUpdateState } from "../update-state";
import { navigate } from "../router";
import { spaceActivity, spacePath, spaceQualifier } from "../space-context";
import { reloadApp } from "../pwa";
import { AppBar, AppShell } from "./AppShell";
import { EmptyState } from "./EmptyState";
import { PullToRefresh } from "./PullToRefresh";
import { RepoPicker } from "./RepoPicker";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Skeleton } from "./ui/skeleton";

export function SpacesView({ tasks, conn, loading }: { tasks: TaskState[]; conn: ConnState; loading: boolean }) {
  const { repos, loading: reposLoading, error, refresh } = useRepos();
  const [query, setQuery] = useActionState("spaces:query", "");
  const [adding, setAdding] = useUpdateState("spaces:adding", false);
  const searchRef = useRef<HTMLInputElement>(null);
  // Freeze the initial activity order while browsing; live counters can update
  // without moving the row under a pointer. Newly connected Spaces append.
  const order = useRef<string[]>([]);
  const rows = useMemo(() => {
    const sorted = [...repos.values()].sort((a, b) => spaceActivity(b.id, tasks).latest - spaceActivity(a.id, tasks).latest || a.name.localeCompare(b.name));
    if (!loading) for (const repo of sorted) if (!order.current.includes(repo.id)) order.current.push(repo.id);
    const positions = new Map(order.current.map((id, index) => [id, index]));
    return sorted.sort((a, b) => (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity));
  }, [repos, tasks, loading]);
  const needle = query.trim().toLocaleLowerCase();
  const matches = rows.filter(repo => `${repo.name} ${repo.path}`.toLocaleLowerCase().includes(needle));
  const pending = reposLoading || loading;
  const clear = () => { setQuery(""); searchRef.current?.focus(); };
  return <AppShell wide>
    <AppBar title="Spaces" conn={conn}>
      <Button variant="ghost" size="icon-lg" aria-label="Add Space" onClick={() => setAdding(true)}><Plus /></Button>
    </AppBar>
    <PullToRefresh className="min-h-0 flex-1" scrollKey={!pending ? `spaces:${query}` : undefined} onRefresh={reloadApp}>
      <div className="flex flex-col gap-4 px-4 pb-[calc(24px+var(--safe-bottom))] pt-2 md:px-6">
        <div className="flex gap-2">
          <Input ref={searchRef} type="search" aria-label="Search Spaces" placeholder="Search Spaces…" value={query}
            onChange={event => setQuery(event.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          {query && <Button variant="ghost" size="icon-lg" aria-label="Clear Space search" onClick={clear}><X /></Button>}
        </div>
        <Button variant="secondary" className="h-auto min-h-20 w-full justify-start gap-3 rounded-2xl px-4 py-3" onClick={() => navigate("/")}>
          <Layers data-icon="inline-start" />
          <span className="flex min-w-0 flex-1 flex-col gap-1 text-left"><span>All spaces</span><span className="text-xs font-normal text-muted-foreground">Tasks across all your Spaces</span></span>
          <ChevronRight data-icon="inline-end" />
        </Button>
        {error && <Alert variant="destructive"><p>{error}</p><Button variant="outline" onClick={() => void refresh().catch(() => {})}>Retry</Button></Alert>}
        {pending ? <div aria-label="Loading Spaces" aria-busy="true" className="flex flex-col gap-6 py-4">
          {[0, 1, 2].map(i => <div key={i} className="flex items-center gap-3"><Skeleton className="size-11 rounded-xl" /><Skeleton className="h-8 w-2/3" /></div>)}
        </div> : <>
          {matches.length > 0 && <section aria-label="Spaces list">
            <div className="flex justify-between px-2 pb-2 text-xs text-muted-foreground"><h2>Spaces</h2><span>Recent activity</span></div>
            {matches.map(repo => <SpaceRow key={repo.id} repo={repo} repos={repos} summary={spaceActivity(repo.id, tasks).summary}
              matchedPath={!!needle && !repo.name.toLocaleLowerCase().includes(needle)} />)}
          </section>}
          {!matches.length && !error && <EmptyState icon={needle ? Search : Folder} title={needle ? "No Spaces found" : "Connect your first Space"}
            subtitle={needle ? "Try another name or folder." : "Connect a folder to start working with Palmagent."}
            action={needle ? { label: "Clear search", onClick: clear } : { label: "Add Space", onClick: () => setAdding(true) }} />}
        </>}
      </div>
    </PullToRefresh>
    <RepoPicker open={adding} repos={[...repos.values()]} onClose={() => setAdding(false)}
      onRegistered={repo => { setAdding(false); navigate(spacePath(repo.id)); }} onChanged={() => void refresh().catch(() => {})} />
  </AppShell>;
}

function SpaceRow({ repo, repos, summary, matchedPath }: { repo: Repo; repos: Map<string, Repo>; summary: string; matchedPath: boolean }) {
  const qualifier = spaceQualifier(repo, repos) ?? (matchedPath ? repo.path : undefined);
  return <Button variant="ghost" className="h-auto min-h-20 w-full justify-start gap-3 rounded-xl px-2 py-3" onClick={() => navigate(spacePath(repo.id))}>
    <span aria-hidden="true" className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">{repo.name.slice(0, 1).toLocaleUpperCase()}</span>
    <span className="flex min-w-0 flex-1 flex-col gap-1 text-left">
      <span className="line-clamp-2 whitespace-normal break-words">{repo.name}</span>
      <span className="text-xs font-normal text-muted-foreground">{summary}</span>
      {qualifier && <span className="truncate text-xs font-normal text-muted-foreground" title={repo.path}>{qualifier}</span>}
    </span><ChevronRight data-icon="inline-end" />
  </Button>;
}
