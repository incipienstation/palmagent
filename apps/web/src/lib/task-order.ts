import type { TaskState } from "@palmagent/shared";

// Pins stay in creation order; the remaining tasks follow recent activity.
export function compareTasks(a: TaskState, b: TaskState): number {
  if (a.pinnedAt !== undefined && b.pinnedAt !== undefined) {
    return a.pinnedAt - b.pinnedAt || a.taskId.localeCompare(b.taskId);
  }
  if (a.pinnedAt !== undefined) return -1;
  if (b.pinnedAt !== undefined) return 1;
  return b.lastActivityAt - a.lastActivityAt;
}
