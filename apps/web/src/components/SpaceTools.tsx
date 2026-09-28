import { useRef, useState } from "react";
import type { Repo, TaskState, TaskStatus } from "@palmagent/shared";
import { MoreHorizontal, SlidersHorizontal, Terminal, X } from "lucide-react";
import { navigate } from "../router";
import { taskDirectoryFor } from "../space-context";
import { statusLabel } from "../lib/status";
import { Button } from "./ui/button";
import { Drawer, DrawerBody, DrawerContent, DrawerFooter, DrawerHeaderRow, DrawerDescription, DrawerHeader, DrawerTitle, DrawerTrigger } from "./ui/drawer";
import { Field, FieldGroup, FieldLabel } from "./ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export type TaskFilter = TaskStatus | "local" | "all";
const statuses: TaskStatus[] = ["awaiting_input", "awaiting_approval", "running", "queued", "idle", "failed", "cancelled", "archived"];

export function TaskFilters({ repo, repos, tasks, directory, onDirectoryChange, status, onStatusChange }: {
  repo?: Repo; repos: Map<string, Repo>; tasks: TaskState[]; directory: string; onDirectoryChange: (value: string) => void;
  status: TaskFilter; onStatusChange: (value: TaskFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  const directories = new Map<string, string>();
  if (repo) for (const task of tasks) {
    if (task.repoId !== repo.id) continue;
    const path = taskDirectoryFor(task, repos);
    directories.set(path, path === repo.path ? "Default folder" : task.branch || path.split("/").at(-1) || path);
  }
  if (directory !== "all" && !directories.has(directory)) directories.set(directory, directory.split("/").at(-1) || directory);
  return <div className="flex min-w-0 flex-wrap items-center gap-2">
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild><Button variant="outline" className="rounded-full"><SlidersHorizontal data-icon="inline-start" />Filters</Button></DrawerTrigger>
      <DrawerContent onOpenAutoFocus={event => { event.preventDefault(); close.current?.focus(); }}>
        <DrawerHeader><DrawerHeaderRow><DrawerTitle>Task filters</DrawerTitle><Button ref={close} variant="ghost" size="icon-lg" aria-label="Close filters" onClick={() => setOpen(false)}><X /></Button></DrawerHeaderRow>
          <DrawerDescription>{repo ? `Tasks in ${repo.name}. Worktree filters only change this list.` : "Tasks across all your Spaces."}</DrawerDescription>
        </DrawerHeader>
        <DrawerBody><FieldGroup>
          <Field><FieldLabel htmlFor="space-status-filter">Status</FieldLabel>
            <Select value={status} onValueChange={value => onStatusChange(value as TaskFilter)}>
              <SelectTrigger id="space-status-filter"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>
                <SelectItem value="all">All statuses</SelectItem>
                {statuses.map(value => <SelectItem key={value} value={value}>{statusLabel(value)}</SelectItem>)}
                <SelectItem value="local">Local sessions</SelectItem>
              </SelectGroup></SelectContent>
            </Select>
          </Field>
          {repo && <Field><FieldLabel htmlFor="space-worktree-filter">Worktree</FieldLabel>
            <Select value={directory} onValueChange={onDirectoryChange}>
              <SelectTrigger id="space-worktree-filter" className="min-w-0"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>
                <SelectItem value="all">All Worktrees</SelectItem>
                {[...directories].map(([path, label]) => <SelectItem key={path} value={path}>{label}</SelectItem>)}
              </SelectGroup></SelectContent>
            </Select>
          </Field>}
        </FieldGroup></DrawerBody>
        <DrawerFooter><Button onClick={() => setOpen(false)}>Done</Button></DrawerFooter>
      </DrawerContent>
    </Drawer>
    {directory !== "all" && <Button variant="secondary" className="min-w-0 max-w-full rounded-full" onClick={() => onDirectoryChange("all")} aria-label="Clear Worktree filter">
      <span className="truncate">Worktree: {directories.get(directory)}</span><X data-icon="inline-end" />
    </Button>}
    {status !== "all" && <Button variant="secondary" className="rounded-full" onClick={() => onStatusChange("all")} aria-label="Clear status filter">{status === "local" ? "Local sessions" : statusLabel(status)}<X data-icon="inline-end" /></Button>}
  </div>;
}

export function SpaceDetails({ repo }: { repo: Repo }) {
  const [open, setOpen] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  return <Drawer open={open} onOpenChange={setOpen}>
    <DrawerTrigger asChild><Button variant="ghost" size="icon-lg" aria-label="Space details"><MoreHorizontal /></Button></DrawerTrigger>
    <DrawerContent onOpenAutoFocus={event => { event.preventDefault(); close.current?.focus(); }}>
      <DrawerHeader><DrawerHeaderRow><DrawerTitle className="min-w-0 break-words">{repo.name}</DrawerTitle><Button ref={close} variant="ghost" size="icon-lg" aria-label="Close Space details" onClick={() => setOpen(false)}><X /></Button></DrawerHeaderRow>
        <DrawerDescription>Space information and tools.</DrawerDescription>
      </DrawerHeader>
      <DrawerBody className="flex flex-col gap-4">
        <Button variant="outline" className="justify-start" onClick={() => { setOpen(false); navigate("/terminals/repo/" + encodeURIComponent(repo.id)); }}><Terminal data-icon="inline-start" />Terminals</Button>
        <div><p className="text-sm font-medium">Connected folder</p><p className="mt-1 break-all text-sm text-muted-foreground">{repo.path}</p></div>
        <p className="text-sm text-muted-foreground">This Space includes tasks in all of its Worktrees.</p>
      </DrawerBody>
    </DrawerContent>
  </Drawer>;
}
