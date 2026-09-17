import type { TaskState } from "@palmagent/shared";

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
