import { useSyncExternalStore } from "react";
import type { TaskState } from "@palmagent/shared";
import { api } from "./api";
import { cacheSession, onCacheSessionReset } from "./query-lifecycle";
import { dismissToast, toast } from "./components/ui/toaster";

type Change = { title?: string; pinnedAt?: number | null; hidden?: boolean; pending: boolean; acknowledgedAt?: number };
const renameDrafts = new Map<string, string>();
export const getRenameDraft = (id: string) => renameDrafts.get(id);
export const clearRenameDraft = (id: string) => { renameDrafts.delete(id); };
let changes = new Map<string, Change>();
const listeners = new Set<() => void>();
const publish = () => { changes = new Map(changes); listeners.forEach(fn => fn()); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const useTaskMutations = () => useSyncExternalStore(subscribe, () => changes);

// Archive removes the worktree permanently. Keep list archives local until the
// undo feedback expires; several quick archives share one undo window. If that
// feedback is dismissed or replaced, restore them instead of committing early.
const queuedArchives = new Map<string, Change | undefined>();
let archiveToast: number | undefined;
export function queueTaskArchive(taskId: string) {
  if (changes.get(taskId)?.pending) return;
  queuedArchives.set(taskId, changes.get(taskId));
  changes.set(taskId, { ...changes.get(taskId), hidden: true, pending: true });
  if (archiveToast !== undefined) {
    const previous = archiveToast;
    archiveToast = undefined;
    dismissToast(previous);
  }
  const id = toast({
    title: queuedArchives.size === 1 ? "Task ready to archive" : `${queuedArchives.size} tasks ready to archive`,
    description: "Archiving deletes the worktree and ends this conversation.",
    duration: 8000,
    action: { label: "Undo", onClick: () => dismissToast(id) },
    onClose: reason => {
      if (archiveToast !== id) return;
      archiveToast = undefined;
      const queued = [...queuedArchives];
      queuedArchives.clear();
      for (const [taskId, previous] of queued) {
        if (previous) changes.set(taskId, previous); else changes.delete(taskId);
      }
      if (reason === "expire") {
        for (const [taskId] of queued) void mutateTask(taskId, { hidden: true });
      } else publish();
    },
  });
  archiveToast = id;
  publish();
}
export function projectTask(task: TaskState | undefined, entries: ReadonlyMap<string, Change>) {
  const change = task && entries.get(task.taskId);
  if (!task || !change) return task;
  return { ...task, ...(change.title !== undefined ? { title: change.title } : {}),
    ...("pinnedAt" in change ? { pinnedAt: change.pinnedAt ?? undefined } : {}) };
}
export function observeTaskMutation(task: TaskState) {
  const change = changes.get(task.taskId);
  if (!change || change.pending) return;
  if (task.updatedAt > (change.acknowledgedAt ?? Infinity)
    || ((!change.hidden || task.status === "archived")
      && (change.title === undefined || task.title === change.title)
      && (!("pinnedAt" in change) || (task.pinnedAt ?? null) === change.pinnedAt))) {
    changes.delete(task.taskId); publish();
  }
}
export async function mutateTask(taskId: string, change: { title: string } | { pinnedAt: number | null } | { hidden: true }): Promise<boolean> {
  if (changes.get(taskId)?.pending) return false;
  const generation = cacheSession();
  const previous = changes.get(taskId);
  if ("title" in change) renameDrafts.set(taskId, change.title);
  changes.set(taskId, { ...previous, ...change, pending: true }); publish();
  try {
    const actual = "title" in change ? await api.renameTask(taskId, { title: change.title }) : "pinnedAt" in change ? await api.pinTask(taskId, change.pinnedAt !== null) : await api.archive(taskId);
    if (generation !== cacheSession()) return false;
    if ("title" in change) renameDrafts.delete(taskId);
    changes.set(taskId, { title: actual.title, pinnedAt: actual.pinnedAt ?? null, hidden: "hidden" in change ? actual.status === "archived" : previous?.hidden, pending: false, acknowledgedAt: actual.updatedAt });
    return true;
  } catch (error) {
    if (generation !== cacheSession()) return false;
    if (previous) changes.set(taskId, previous); else changes.delete(taskId);
    publish();
    toast({ title: "title" in change ? "Couldn't rename this session" : "pinnedAt" in change ? "Couldn't update this pin" : "Couldn't archive this task", description: error instanceof Error ? error.message : "Try again.", variant: "destructive" });
    // The write may have succeeded despite a lost response. Reconcile, without
    // replaying a destructive operation or overwriting a newer local mutation.
    const rollback = changes.get(taskId);
    try {
      const actual = await api.getTask(taskId);
      if (generation === cacheSession() && changes.get(taskId) === rollback) changes.set(taskId, {
        title: actual.title, pinnedAt: actual.pinnedAt ?? null, hidden: actual.status === "archived", pending: false, acknowledgedAt: actual.updatedAt,
      });
    } catch { /* Keep the last confirmed view until the stream reconnects. */ }
    return false;
  } finally { if (generation === cacheSession()) publish(); }
}
onCacheSessionReset(() => {
  if (archiveToast !== undefined) dismissToast(archiveToast);
  queuedArchives.clear();
  changes.clear(); renameDrafts.clear(); publish();
});
