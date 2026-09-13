import type { TaskState } from "@palmagent/shared";

export function taskTitle(task: TaskState): string {
  return task.title?.trim() || task.prompt.split("\n").find((line) => line.trim())?.trim() || "(untitled task)";
}
