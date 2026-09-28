import { useMemo, useRef, useState } from "react";
import type { Repo, TaskState } from "@palmagent/shared";
import { ChevronRight, Folder, Layers, Plus, Search, X } from "lucide-react";
import type { ConnState } from "../hooks/useInbox";
import { useRepos } from "../hooks/useRepos";
import { useActionState } from "../action-state";
import { useUpdateState } from "../update-state";
import { navigate } from "../router";
import { spaceActivity, spacePath, spaceQualifier } from "../space-context";

import { AppBar, AppShell } from "./AppShell";
import { EmptyState } from "./EmptyState";
import { PullToRefresh } from "./PullToRefresh";
import { RepoPicker } from "./RepoPicker";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import { Skeleton } from "./ui/skeleton";

export function SpacesView({ tasks, conn, loading, onRefresh }: { tasks: TaskState[]; conn: ConnState; loading: boolean; onRefresh: () => Promise<void> }) {
  const { repos, loading: reposLoading, error, refresh } = useRepos();
  const [query, setQuery] = useActionState("spaces:query", "");
  const [adding, setAdding] = useUpdateState("spaces:adding", false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [searching, setSearching] = useState(false);
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
  const closeSearch = () => { setQuery(""); setSearching(false); searchRef.current?.blur(); };
  return <AppShell wide>
    <AppBar title="Spaces" conn={conn}>
      <Button variant="ghost" size="icon-lg" aria-label="Add Space" onClick={() => setAdding(true)}><Plus /></Button>
    </AppBar>
    <div className="flex min-h-0 flex-1 flex-col">
      <form role="search" aria-label="Find a Space" className="order-last flex shrink-0 items-center gap-2 px-4 pt-3 pb-[max(12px,var(--safe-bottom))] md:order-first md:px-6 md:py-2"
        onSubmit={event => { event.preventDefault(); searchRef.current?.blur(); }}
        onFocus={() => setSearching(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setSearching(false); }}>
        <InputGroup className="h-12 flex-1 flex-nowrap gap-3 rounded-full px-4" onClick={() => searchRef.current?.focus()}>
          <InputGroupInput ref={searchRef} type="search" aria-label="Search Spaces" placeholder="Search Spaces…" value={query}
            onChange={event => setQuery(event.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="search"
            onKeyDown={event => { if (event.key === "Escape" && !event.nativeEvent.isComposing) closeSearch(); }} />
          <InputGroupAddon><Search aria-hidden="true" className="size-5 text-muted-foreground" /></InputGroupAddon>
        </InputGroup>
        {(query || searching) && <Button type="button" variant="secondary" size="icon-lg" className="size-12 shrink-0 rounded-full"
          aria-label={query ? "Clear Space search" : "Close Space search"} onClick={closeSearch}><X /></Button>}
      </form>
      <PullToRefresh className="min-h-0 flex-1" scrollKey={!pending ? `spaces:${query}` : undefined} onRefresh={async () => { await Promise.all([onRefresh(), refresh()]); }}>
      <div className="flex flex-col gap-4 px-4 pt-2 pb-4 md:px-6">
        <Button variant="secondary" className="h-auto min-h-20 w-full justify-start gap-3 rounded-2xl px-4 py-3" onClick={() => navigate("/")}>
          <Layers data-icon="inline-start" />
          <span className="flex min-w-0 flex-1 flex-col gap-1 text-left"><span>All spaces</span><span className="text-xs font-normal text-muted-foreground">Tasks across all your Spaces</span></span>
          <ChevronRight data-icon="inline-end" />
        </Button>
        {error && <Alert variant="destructive"><p>{error}</p><Button variant="outline" onClick={() => void refresh().catch(() => {})}>Retry</Button></Alert>}
        {pending ? <div aria-label="Loading Spaces" aria-busy="true" className="flex flex-col gap-6 py-4">
          {[0, 1, 2].map(i => <div key={i} className="flex min-h-18 flex-col justify-center gap-2 px-2"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-3 w-1/3" /></div>)}
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
    </div>
    <RepoPicker open={adding} repos={[...repos.values()]} onClose={() => setAdding(false)}
      onRegistered={repo => { setAdding(false); navigate(spacePath(repo.id)); }} onChanged={() => void refresh().catch(() => {})} />
  </AppShell>;
}

function SpaceRow({ repo, repos, summary, matchedPath }: { repo: Repo; repos: Map<string, Repo>; summary: string; matchedPath: boolean }) {
  const qualifier = spaceQualifier(repo, repos) ?? (matchedPath ? repo.path : undefined);
  return <Button variant="ghost" className="h-auto min-h-18 w-full justify-start rounded-xl px-2 py-3" onClick={() => navigate(spacePath(repo.id))}>
    <span className="flex min-w-0 flex-1 flex-col gap-1 text-left">
      <span className="line-clamp-2 whitespace-normal break-words text-base">{repo.name}</span>
      <span className="text-xs font-normal text-muted-foreground">{summary}</span>
      {qualifier && <span className="truncate text-xs font-normal text-muted-foreground" title={repo.path}>{qualifier}</span>}
    </span>
  </Button>;
}
