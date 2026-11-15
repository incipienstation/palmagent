import type { TaskHistoryResponse, TaskHistoryChangesResponse } from "@palmagent/shared";

/** Reads the committed display projection after the API owner refreshes it. */
export interface TaskTranscriptReader {
  conversationPage(taskId: string, before?: number): Promise<TaskHistoryResponse>;
  conversationChanges(taskId: string, after: number, through?: number, afterKey?: number): Promise<TaskHistoryChangesResponse>;
}
