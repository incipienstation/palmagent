import type { SseTaskChangesFrame, TaskState } from "@palmagent/shared";

// Snapshots are JSON DTOs. Compare the complete record (including nested queue,
// approval and ownership state), not timestamps that can stay unchanged.
export function reconcileTasks(previous: TaskState[], incoming: TaskState[]): TaskState[] {
  const byId = new Map(previous.map(task => [task.taskId, task]));
  const next = incoming.map(task => {
    const old = byId.get(task.taskId);
    return old && JSON.stringify(old) === JSON.stringify(task) ? old : task;
  });
  return next.length === previous.length && next.every((task, index) => task === previous[index]) ? previous : next;
}

export function applyTaskChanges(previous: TaskState[], change: SseTaskChangesFrame): TaskState[] {
  const replacements = new Map(change.tasks.map(task => [task.taskId, task]));
  const removed = new Set(change.removed);
  const next: TaskState[] = [];
  for (const task of previous) {
    if (removed.has(task.taskId)) continue;
    next.push(replacements.get(task.taskId) ?? task);
    replacements.delete(task.taskId);
  }
  if (replacements.size) {
    next.push(...replacements.values());
    next.sort((a, b) => a.createdAt - b.createdAt);
  }
  return next;
}
