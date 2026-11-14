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
export async function moveTaskPin(pins: TaskState[], taskId: string, targetId: string, placement: "before" | "after"): Promise<boolean> {
  if (taskId === targetId || pins.some(task => changes.get(task.taskId)?.pending)) return false;
  const task = pins.find(task => task.taskId === taskId);
  if (!task || !pins.some(task => task.taskId === targetId)) return false;
  const ordered = pins.filter(task => task.taskId !== taskId);
  ordered.splice(ordered.findIndex(task => task.taskId === targetId) + (placement === "after" ? 1 : 0), 0, task);
  if (ordered.every((task, i) => task.taskId === pins[i].taskId)) return false;
  const generation = cacheSession();
  const previous = new Map(pins.map(task => [task.taskId, changes.get(task.taskId)]));
  for (const [index, task] of ordered.entries()) {
    changes.set(task.taskId, { ...previous.get(task.taskId), pinnedAt: pins[index].pinnedAt, pending: true });
  }
  publish();
  const accept = (actual: TaskState) => changes.set(actual.taskId, {
    ...previous.get(actual.taskId), pinnedAt: actual.pinnedAt ?? null,
    pending: false, acknowledgedAt: actual.updatedAt,
  });
  try {
    const actual = await api.moveTaskPin(taskId, targetId, placement);
    if (generation !== cacheSession()) return false;
    // A pin may have been removed by another client while this request was in flight.
    const removed = await Promise.all(pins.filter(task => !actual.some(t => t.taskId === task.taskId)).map(task => api.getTask(task.taskId)));
    if (generation !== cacheSession()) return false;
    for (const task of [...actual, ...removed]) if (previous.has(task.taskId)) accept(task);
    return true;
  } catch (error) {
    if (generation !== cacheSession()) return false;
    // Keep actions locked until reconciliation settles: a lost response can hide a successful write.
    const actual = await Promise.allSettled(pins.map(task => api.getTask(task.taskId)));
    if (generation !== cacheSession()) return false;
    for (const [index, result] of actual.entries()) {
      const id = pins[index].taskId;
      if (result.status === "fulfilled") accept(result.value);
      else if (previous.get(id)) changes.set(id, previous.get(id)!);
      else changes.delete(id);
    }
    toast({ title: "Couldn't reorder pinned chats", description: error instanceof Error ? error.message : "Try again.", variant: "destructive" });
    return false;
  } finally { if (generation === cacheSession()) publish(); }
}

onCacheSessionReset(() => {
  if (archiveToast !== undefined) dismissToast(archiveToast);
  queuedArchives.clear();
  changes.clear(); renameDrafts.clear(); publish();
});
