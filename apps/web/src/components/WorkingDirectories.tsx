import type { Repo, TaskState } from "@palmagent/shared";
import { Check, ChevronDown, Folder, GitBranch, Layers, Search, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useAppNavigation } from "./AppNavigation";
import { EmptyState } from "./EmptyState";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle, DrawerTrigger } from "./ui/drawer";
import { Input } from "./ui/input";
import { ALL_SPACES, taskDirectoryFor } from "../space-context";

export const taskDirectory = taskDirectoryFor;

type Space = { path: string; name: string; count: number; worktree: boolean; project?: string; repoId?: string };
const leaf = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

function spacesFor(tasks: TaskState[], repos: Map<string, Repo>, selected: string): Space[] {
  const spaces = new Map<string, Space>();
  for (const repo of repos.values()) {
    spaces.set(repo.path, { path: repo.path, name: repo.name, count: 0, worktree: false, repoId: repo.id });
  }
  for (const task of tasks) {
    const path = taskDirectory(task, repos);
    const repo = repos.get(task.repoId);
    if (repo && path !== repo.path) spaces.get(repo.path)!.count++;
    const space = spaces.get(path) ?? {
      path, name: leaf(path), count: 0,
      worktree: !!task.worktreePath && task.worktreePath !== repo?.path,
      project: repo?.name,
      repoId: task.repoId,
    };
    space.count++;
    spaces.set(path, space);
  }
  // A saved filter can outlive its repo or last task. Keep it identifiable and
  // let the user explicitly return to All spaces instead of changing scope.
  if (selected !== ALL_SPACES && !spaces.has(selected)) {
    spaces.set(selected, { path: selected, name: leaf(selected), count: 0, worktree: false });
  }
  return [...spaces.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

function SpaceRow({ space, selected, onSelect }: {
  space: Space; selected: string; onSelect: (path: string, repoId?: string) => void;
}) {
  const Icon = space.worktree ? GitBranch : Folder;
  return (
    <Button
      variant={selected === space.path ? "selected" : "ghost"}
      className="h-auto min-h-14 w-full min-w-0 justify-start px-3 py-2.5"
      title={space.path}
      aria-current={selected === space.path ? "page" : undefined}
      onClick={() => onSelect(space.path, space.repoId)}
    >
      <Icon data-icon="inline-start" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className="truncate">{space.name}</span>
        {space.worktree && space.project && <span className="truncate text-xs font-normal text-muted-foreground">{space.project}</span>}
        <span className="whitespace-normal text-xs font-normal text-muted-foreground [overflow-wrap:anywhere] md:truncate md:text-left md:[direction:rtl] md:[unicode-bidi:plaintext]">{space.path}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <Badge variant="secondary" aria-label={`${space.count} tasks`}>{space.count}</Badge>
        {selected === space.path && <Check aria-hidden="true" />}
      </span>
    </Button>
  );
}

function SpaceList({ spaces, total, selected, onSelect }: {
  spaces: Space[]; total: number; selected: string; onSelect: (path: string, repoId?: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const worktreeId = useId();
  const search = query.trim().toLocaleLowerCase();
  const matches = spaces.filter((space) => `${space.name} ${space.path} ${space.project ?? ""}`.toLocaleLowerCase().includes(search));
  const directories = matches.filter((space) => !space.worktree);
  const worktrees = matches.filter((space) => space.worktree);
  const showWorktrees = !!search || (expanded ?? spaces.some((space) => space.worktree && space.path === selected));

  return <>
    <div className="flex shrink-0 flex-col gap-3 px-3 pb-3">
      <Input type="search" aria-label="Search spaces" placeholder="Search names or paths…" value={query}
        onChange={(event) => setQuery(event.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      <Button variant={selected === ALL_SPACES ? "selected" : "ghost"} className="w-full justify-start px-3" onClick={() => onSelect(ALL_SPACES)} aria-current={selected === ALL_SPACES ? "page" : undefined}>
        <Layers data-icon="inline-start" />
        <span className="min-w-0 flex-1 text-left">All spaces</span>
        <Badge variant="secondary" aria-label={`${total} tasks`}>{total}</Badge>
        {selected === ALL_SPACES && <Check data-icon="inline-end" aria-hidden="true" />}
      </Button>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-[calc(16px+var(--safe-bottom))]" data-testid="space-results">
      {directories.length > 0 && <section aria-label="Projects and folders" className="flex flex-col gap-1">
        <h3 className="px-3 py-2 text-xs font-medium text-muted-foreground">Projects & folders</h3>
        {directories.map((space) => <SpaceRow key={space.path} space={space} selected={selected} onSelect={onSelect} />)}
      </section>}
      {worktrees.length > 0 && <section aria-label="Worktrees" className="mt-2">
        {search ? <h3 className="flex items-center gap-2 px-3 py-3 text-xs font-medium text-muted-foreground">Worktrees <Badge variant="secondary">{worktrees.length}</Badge></h3> : <Button variant="ghost" className="w-full justify-start px-3" aria-expanded={showWorktrees} aria-controls={worktreeId} onClick={() => setExpanded(!showWorktrees)}>
          <GitBranch data-icon="inline-start" />
          <span className="flex-1 text-left">Worktrees</span>
          <Badge variant="secondary">{worktrees.length}</Badge>
          <ChevronDown data-icon="inline-end" className={showWorktrees ? "rotate-180" : undefined} />
        </Button>}
        <div id={worktreeId} hidden={!showWorktrees} className="flex flex-col gap-1">
          {worktrees.map((space) => <SpaceRow key={space.path} space={space} selected={selected} onSelect={onSelect} />)}
        </div>
      </section>}
      {matches.length === 0 && <div role="status"><EmptyState icon={Search} title="No spaces found" subtitle="Try another name or part of a path." action={query ? { label: "Clear search", onClick: () => setQuery("") } : undefined} /></div>}
    </div>
  </>;
}

export function WorkingDirectories({ tasks, repos, selected, onSelect, loading = false }: {
  tasks: TaskState[]; repos: Map<string, Repo>; selected: string; onSelect: (path: string, repoId?: string) => void; loading?: boolean;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const navigation = useAppNavigation();
  const open = navigation?.spacesOpen ?? localOpen;
  const setOpen = navigation?.setSpacesOpen ?? setLocalOpen;
  const closeRef = useRef<HTMLButtonElement>(null);
  if (loading) return <div className="shrink-0 px-4 py-2 md:w-64">
    <Button variant="outline" disabled className="w-full justify-start">Loading spaces…</Button>
  </div>;
  const spaces = spacesFor(tasks, repos, selected);
  const current = spaces.find((space) => space.path === selected);
  const Icon = selected === ALL_SPACES ? Layers : current?.worktree ? GitBranch : Folder;
  const name = selected === ALL_SPACES ? "All spaces" : current?.name ?? leaf(selected);
  return <>
    <div className="min-w-0 px-4 py-2 md:hidden">
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>
          <Button variant="ghost" aria-label={`Switch space: ${name}`} className="w-full min-w-0 justify-start rounded-xl px-3 text-muted-foreground">
            <Icon data-icon="inline-start" />
            <span className="min-w-0 flex-1 truncate text-left">{name}</span>
            <Badge variant="secondary">{selected === ALL_SPACES ? tasks.length : current?.count ?? 0}</Badge>
            <ChevronDown data-icon="inline-end" />
          </Button>
        </DrawerTrigger>
        <DrawerContent className="h-[min(85dvh,680px)] min-w-0" onOpenAutoFocus={(event) => {
          // Opening the picker should not summon a phone keyboard before a tap.
          event.preventDefault(); closeRef.current?.focus();
        }}>
          <DrawerHeader className="shrink-0 border-b-0">
            <div className="flex items-center gap-2">
              <DrawerTitle>Spaces</DrawerTitle>
              <DrawerClose asChild><Button ref={closeRef} variant="ghost" size="icon-lg" aria-label="Close spaces"><X /></Button></DrawerClose>
            </div>
            <DrawerDescription>Filter by project, folder, or one worktree. Projects include their worktrees.</DrawerDescription>
          </DrawerHeader>
          <SpaceList spaces={spaces} total={tasks.length} selected={selected} onSelect={(path, repoId) => { onSelect(path, repoId); setOpen(false); }} />
        </DrawerContent>
      </Drawer>
    </div>
    <nav aria-label="Spaces" className="hidden w-64 min-w-0 shrink-0 flex-col overflow-hidden border-r md:flex">
      <h2 className="px-6 py-4 text-sm font-semibold">Spaces</h2>
      <SpaceList spaces={spaces} total={tasks.length} selected={selected} onSelect={onSelect} />
    </nav>
  </>;
}
