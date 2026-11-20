import type { MessageAction, TaskState } from "@palmagent/shared";
import type { MessageState, StoredMessage } from "../../../domain/models.js";

export type QueueOperation =
  | { kind: "submit"; message: StoredMessage; expectedRunId?: string | null; canStart: boolean; hasSettings: boolean }
  | { kind: "act"; id: string; action: MessageAction & { attachments?: StoredMessage["attachments"] }; now: number; canStart: boolean }
  | { kind: "claimSend"; id: string; canStart: boolean }
  | { kind: "claimNext"; now: number; canStart: boolean }
  | { kind: "beginRun"; id: string; initialMessage?: string; compaction?: string; retained: boolean }
  | { kind: "rejectBeforeStart"; error: string }
  | { kind: "rejectStart"; id: string; error: string }
  | { kind: "delivered"; id: string }
  | { kind: "sharedDeliveryFailed"; id: string; unknown: boolean }
  | { kind: "settleSteer"; id: string; delivery: "unknown" | "delivered" | "rejected" | "receiptLost" }
  | { kind: "finish"; failed: boolean; error?: string }
  | { kind: "recover"; live: boolean }
  | { kind: "sharedRuntimeStarted" | "stopWaiting" | "pause" | "resume" };

export interface QueueReceipt {
  changed: boolean;
  claimed?: StoredMessage;
  runId: string | null;
  state?: MessageState;
}

export interface TurnTicket { taskId: string; generation: number }
export type TurnObservation = { kind: "error"; message?: string } | { kind: "result"; failed: boolean }
  | { kind: "processExit"; success: boolean } | { kind: "reattachFailed" | "output" };
export type TurnDisposition = "ignore" | "replay" | "publish" | "stopForSessionMismatch";

export interface RecoveryResult {
  reattached: string[];
  recovered: string[];
}

/** The coordinator holds admission and callbacks until recovery commits. */
export type TaskMetadata = Pick<import("./persistence.js").TaskRepository,
  "setTaskPin" | "setTaskPinOrder" | "setTaskTitle" | "setTaskStatus" | "setTaskSession" |
  "setSessionControl" | "setTaskSettings" | "setTaskPrs" | "setTaskPendingInput" | "setTaskPendingApproval" | "insertApproval"> & {
    transaction(work: () => void): void;
  };

export interface RetainedTurns {
  readonly metadata: TaskMetadata;
  readonly attachments: import("./attachments.js").AttachmentIndex;
  create<T>(task: TaskState, prepareFiles: () => T): T;
  recover(live: string[], reattach: (taskId: string) => void, now: number): RecoveryResult;
  track(taskId: string, runId: string | null, baseline: number): TurnTicket;
  observe(ticket: TurnTicket, event: TurnObservation, expectedSession?: string, observedSession?: string, rawSeq?: number): TurnDisposition;
  end(ticket: TurnTicket): import("../../../domain/turn-policy.js").TurnEvidence | null;
  queue(taskId: string, operation: QueueOperation, snapshot?: MessageState): QueueReceipt;
  start(taskId: string, runId: string, now: number): void;
}
