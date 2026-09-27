import { useSyncExternalStore } from "react";
import type { MessageQueue, TaskState } from "@palmagent/shared";
import { onCacheSessionReset } from "./query-lifecycle";
import { beginBrowserWork } from "./update-state";

const actionLabels = {
  send: "Sending message…", sendQueued: "Sending queued message…", enqueue: "Adding to queue…",
  acquireEdit: "Preparing edit…", saveEdit: "Saving message…", releaseEdit: "Releasing edit…",
  deleteQueued: "Removing message…", resumeQueue: "Resuming queue…", resumeDelivery: "Resuming delivery…",
  cancel: "Cancelling task…", answer: "Sending answer…", skipQuestion: "Skipping question…",
  approve: "Approving…", deny: "Denying…", handoff: "Preparing shell handoff…", dispatch: "Creating task…",
  stop: "Stopping turn…",
} as const;
export type TaskActionKind = keyof typeof actionLabels;
export const isSendingAction = (kind?: TaskActionKind) => kind === "send" || kind === "sendQueued";

export type QueuePreview = { apply: (queue: MessageQueue) => MessageQueue; id?: string; label: string; submission?: boolean };
interface Activity { kind?: TaskActionKind; token?: symbol; label?: string; preview?: QueuePreview; queue?: MessageQueue; settled?: Promise<void>; onStop?: () => Promise<void>; stopping?: symbol }
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
export function beginTaskAction(id: string, kind: TaskActionKind, preview?: QueuePreview, onStop?: () => Promise<void>, label: string = actionLabels[kind]) {
  if (activities.get(id)?.kind) return;
  const finish = beginBrowserWork();
  const token = Symbol();
  let resolve!: () => void;
  const settled = new Promise<void>(done => { resolve = done; });
  activities.set(id, { ...activities.get(id), kind, label, preview, token, settled, onStop }); notify();
  return () => {
    const previous = activities.get(id);
    if (previous?.token === token) activities.set(id, { queue: previous.queue, ...(previous.stopping ? { stopping: previous.stopping, kind: "stop" as const, label: actionLabels.stop } : {}) });
    resolve(); finish(); notify();
  };
}
// Stop reserves the next action immediately, then waits for any submission to
// settle so its request cannot overtake the message or task being created.
export function beginTaskStop(id: string) {
  const previous = activities.get(id) ?? empty;
  if (previous.stopping) return;
  const finish = beginBrowserWork();
  const token = Symbol();
  activities.set(id, { ...previous, stopping: token, kind: "stop", label: actionLabels.stop }); notify();
  return {
    ready: previous.settled ?? Promise.resolve(),
    onStop: previous.onStop,
    finish: () => {
      const current = activities.get(id);
      if (current?.stopping === token) activities.set(id, { queue: current.queue });
      finish(); notify();
    },
  };
}
onCacheSessionReset(() => { for (const waiting of stopped.values()) waiting.finish(); stopped.clear(); latestTasks.clear(); activities.clear(); notify(); });
