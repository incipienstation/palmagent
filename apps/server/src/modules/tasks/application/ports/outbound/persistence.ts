import type { AgentEvent, AgentUsage, PermissionRequest, PrRef, QuestionRequest, TaskActivityDetailsResponse, TaskHistoryChangesResponse, TaskHistoryResponse, TaskState, TaskStatus } from "@palmagent/shared";
import type { EventRow, MessageState } from "../../../domain/models.js";

export interface TaskRepository extends MessageStateRepository, TaskHistoryReader {
  getTask(id: string): TaskState | undefined;
  listTasks(status?: TaskStatus): TaskState[];
  insertTask(task: TaskState): void;
  setSessionControl(id: string, control: TaskState["sessionControl"]): void;
  setTaskPin(id: string, pinned: boolean, now: number): number | undefined;
  setTaskTitle(id: string, title: string, now: number): void;
  setTaskStatus(id: string, status: TaskStatus, interrupted: boolean, now: number): void;
  setTaskSession(id: string, sessionId: string, now: number): void;
  setTaskSettings(id: string, model: string | undefined, effort: string | undefined, permission: string, now: number): void;
  setTaskPrs(id: string, prs: PrRef[], now: number): void;
  setTaskPendingInput(id: string, pending: QuestionRequest | undefined, now: number): void;
  setTaskPendingApproval(id: string, pending: PermissionRequest | undefined, now: number): void;
  setTaskRawSeq(id: string, seq: number): void;
  getTaskRawSeq(id: string): number;
  appendAgentEvents(taskId: string, events: AgentEvent[], rawSeq?: number): EventRow[];
  importSessionEvents(task: TaskState, events: AgentEvent[]): EventRow[];
  inFlightTaskIds(): string[];
  resetInterruptedTasks(ids: string[], now: number): void;
  insertApproval(taskId: string, eventId: number | null, requestJson: string | null, decision: string, decidedAt: number): void;
  usageByAgent(): AgentUsage[];
  transaction<T>(work: () => T): T;
}

export interface MessageStateRepository {
  readonly isOpen: boolean;
  readMessageState(id: string): MessageState | undefined;
  messageTaskIds(): string[];
  writeMessageState(id: string, state: MessageState): void;
}

export interface TaskHistoryReader {
  eventCursor(taskId?: string): number;
  historyPage(taskId: string, before: number, cursor?: number, includeActivityDetails?: boolean): TaskHistoryResponse;
  latestHistoryPage(taskId: string, includeActivityDetails?: boolean): TaskHistoryResponse;
  historyChanges(taskId: string, after: number, through?: number, includeActivityDetails?: boolean): TaskHistoryChangesResponse;
  activityDetails(taskId: string, from: number, through: number): TaskActivityDetailsResponse;
}
