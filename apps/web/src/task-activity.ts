import { useSyncExternalStore } from "react";
import type { MessageQueue, TaskState } from "@palmagent/shared";
import { onCacheSessionReset } from "./read-cache";
import { beginBrowserWork } from "./update-state";

export type QueuePreview = { apply: (queue: MessageQueue) => MessageQueue; id?: string; label: string; submission?: boolean };
interface Activity { token?: symbol; label?: string; preview?: QueuePreview; queue?: MessageQueue }
const empty: Activity = {};
const stopped = new Map<string, { finish: () => void; runId?: string | null }>();
const latestTasks = new Map<string, TaskState>();
const active = (task: TaskState) => ["queued", "running", "awaiting_input", "awaiting_approval"].includes(task.status);
export function observeTaskActivity(task: TaskState) {
  if (task.updatedAt < (latestTasks.get(task.taskId)?.updatedAt ?? -Infinity)) return;
  latestTasks.set(task.taskId, task);
  if (task.messageQueue) acceptMessageQueue(task.taskId, task.messageQueue);
  const waiting = stopped.get(task.taskId);
  if (waiting && (!active(task) || (waiting.runId && task.messageQueue?.runId && task.messageQueue.runId !== waiting.runId))) {
    stopped.delete(task.taskId); waiting.finish();
  }
}
export function finishWhenStopped(id: string, finish: () => void, runId?: string | null) {
  stopped.set(id, { finish, runId });
  const latest = latestTasks.get(id);
  if (latest) observeTaskActivity(latest);
}
const activities = new Map<string, Activity>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(fn => fn());
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const useTaskActivity = (id: string) => useSyncExternalStore(subscribe, () => activities.get(id) ?? empty);
export function acceptMessageQueue(id: string, queue: MessageQueue) {
  const previous = activities.get(id) ?? empty;
  if (queue.revision < (previous.queue?.revision ?? -1)) return;
  // Once the server owns a submitted message, its receipt replaces the local
  // preview. A later delivery snapshot must not re-add that preview while the
  // original HTTP request is still in flight.
  const preview = previous.preview?.submission && queue.messages.some(m => m.id === previous.preview?.id)
    ? undefined : previous.preview;
  activities.set(id, { ...previous, queue, preview }); notify();
}
export function clearQueuePreview(id: string) {
  const previous = activities.get(id);
  if (previous) { activities.set(id, { ...previous, preview: undefined }); notify(); }
}
export function beginTaskAction(id: string, label: string, preview?: QueuePreview) {
  if (activities.get(id)?.label) return;
  const finish = beginBrowserWork();
  const token = Symbol();
  activities.set(id, { ...activities.get(id), label, preview, token }); notify();
  return () => {
    const previous = activities.get(id);
    if (previous?.token === token) activities.set(id, { queue: previous.queue });
    finish(); notify();
  };
}
onCacheSessionReset(() => { for (const waiting of stopped.values()) waiting.finish(); stopped.clear(); latestTasks.clear(); activities.clear(); notify(); });
