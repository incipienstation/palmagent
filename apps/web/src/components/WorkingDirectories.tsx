import type { Repo, TaskState } from "@palmagent/shared";
import { Folder } from "lucide-react";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export function taskDirectory(task: TaskState, repos: Map<string, Repo>): string {
  return task.worktreePath ?? repos.get(task.repoId)?.path ?? `repo:${task.repoId}`;
}
export function WorkingDirectories({ tasks, repos, selected, onSelect }: {
  tasks: TaskState[]; repos: Map<string, Repo>; selected: string; onSelect: (path: string) => void;
}) {
  const paths = new Map<string, number>([...repos.values()].map((r) => [r.path, 0]));
  for (const task of tasks) { const path = taskDirectory(task, repos); paths.set(path, (paths.get(path) ?? 0) + 1); }
  const entries = [...paths].sort(([a], [b]) => a.localeCompare(b));
  const label = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;
  return <>
    <div className="px-4 py-2 md:hidden">
      <Select value={selected} onValueChange={onSelect}>
        <SelectTrigger aria-label="Working directory" className="w-full"><SelectValue placeholder="All directories" /></SelectTrigger>
        <SelectContent><SelectGroup>
          <SelectItem value="all">All directories · {tasks.length}</SelectItem>
          {entries.map(([path, count]) => <SelectItem key={path} value={path}>{path} · {count}</SelectItem>)}
        </SelectGroup></SelectContent>
      </Select>
    </div>
    <nav aria-label="Working directories" className="hidden w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r p-3 md:flex">
      <h2 className="px-2 py-2 text-sm font-semibold">Working directories</h2>
      <Button variant={selected === "all" ? "secondary" : "ghost"} className="justify-start" onClick={() => onSelect("all")} aria-current={selected === "all" ? "page" : undefined}>All directories · {tasks.length}</Button>
      {entries.map(([path, count]) => <Button key={path} variant={selected === path ? "secondary" : "ghost"} className="h-auto min-h-11 justify-start" title={path} aria-current={selected === path ? "page" : undefined} onClick={() => onSelect(path)}>
        <Folder data-icon="inline-start" />
        <span className="min-w-0 flex-1 text-left"><span className="block truncate">{label(path)} · {count}</span><span className="block truncate text-xs">{path}</span></span>
      </Button>)}
    </nav>
  </>;
}
