import type { TaskActivityDetailsResponse } from "@palmagent/shared";

/** Read-only activity expansion; Task/event write ownership remains in the API process. */
export interface TaskActivityReader {
  activityDetails(taskId: string, from: number, through: number): TaskActivityDetailsResponse | Promise<TaskActivityDetailsResponse>;
}
