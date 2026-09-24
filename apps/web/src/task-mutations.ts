import { useSyncExternalStore } from "react";
import type { TaskState } from "@palmagent/shared";
import { api } from "./api";
import { cacheSession, onCacheSessionReset } from "./query-lifecycle";
import { toast } from "./components/ui/toaster";

type Change = { title?: string; hidden?: boolean; pending: boolean; acknowledgedAt?: number };
const renameDrafts = new Map<string, string>();
export const getRenameDraft = (id: string) => renameDrafts.get(id);
export const clearRenameDraft = (id: string) => { renameDrafts.delete(id); };
let changes = new Map<string, Change>();
const listeners = new Set<() => void>();
const publish = () => { changes = new Map(changes); listeners.forEach(fn => fn()); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const useTaskMutations = () => useSyncExternalStore(subscribe, () => changes);
export function projectTask(task: TaskState | undefined, entries: ReadonlyMap<string, Change>) {
  const change = task && entries.get(task.taskId);
  return task && change?.title !== undefined ? { ...task, title: change.title } : task;
}
export function observeTaskMutation(task: TaskState) {
  const change = changes.get(task.taskId);
  if (!change || change.pending) return;
  if (task.updatedAt > (change.acknowledgedAt ?? Infinity)
    || (change.hidden ? task.status === "archived" : task.title === change.title)) {
    changes.delete(task.taskId); publish();
  }
}
export async function mutateTask(taskId: string, change: { title: string } | { hidden: true }): Promise<boolean> {
  if (changes.get(taskId)?.pending) return false;
  const generation = cacheSession();
  const previous = changes.get(taskId);
  if ("title" in change) renameDrafts.set(taskId, change.title);
  changes.set(taskId, { ...change, pending: true }); publish();
  try {
    const actual = "title" in change ? await api.renameTask(taskId, { title: change.title }) : await api.archive(taskId);
    if (generation !== cacheSession()) return false;
    if ("title" in change) renameDrafts.delete(taskId);
    changes.set(taskId, { ...("title" in change ? { title: actual.title } : { hidden: actual.status === "archived" }), pending: false, acknowledgedAt: actual.updatedAt });
    return true;
  } catch (error) {
    if (generation !== cacheSession()) return false;
    if (previous) changes.set(taskId, previous); else changes.delete(taskId);
    publish();
    toast({ title: "title" in change ? "Couldn't rename this session" : "Couldn't archive this task", description: error instanceof Error ? error.message : "Try again.", variant: "destructive" });
    // The write may have succeeded despite a lost response. Reconcile, without
    // replaying a destructive operation or overwriting a newer local mutation.
    const rollback = changes.get(taskId);
    try {
      const actual = await api.getTask(taskId);
      if (generation === cacheSession() && changes.get(taskId) === rollback) changes.set(taskId, {
        title: actual.title, hidden: actual.status === "archived", pending: false, acknowledgedAt: actual.updatedAt,
      });
    } catch { /* Keep the last confirmed view until the stream reconnects. */ }
    return false;
  } finally { if (generation === cacheSession()) publish(); }
}
onCacheSessionReset(() => { changes.clear(); renameDrafts.clear(); publish(); });
