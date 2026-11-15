import type { ConversationSteps, TaskHistoryResponse, TaskHistoryChangesResponse } from "@palmagent/shared";

/** Reads the committed display projection after the API owner refreshes it. */
export interface TaskTranscriptReader {
  conversationSteps(taskId: string, key: number, after?: number): Promise<ConversationSteps>;
  conversationPage(taskId: string, before?: number): Promise<TaskHistoryResponse>;
  conversationChanges(taskId: string, after: number, through?: number, afterKey?: number): Promise<TaskHistoryChangesResponse>;
}
