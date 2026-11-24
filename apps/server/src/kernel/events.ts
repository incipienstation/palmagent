import type { AgentEvent, TaskState, SseTaskChangesFrame, SseTasksFrame, SseReadChangeFrame } from "@palmagent/shared";

export interface EventRow {
  id: number;
  seq: number;
  event: AgentEvent;
}

export interface ReadChangePublisher { emitReadChange(change: SseReadChangeFrame): void }

export interface TaskEventPublisher {
  emitEvent(row: EventRow): void;
  emitTaskChanges(tasks: TaskState[], removed: string[]): void;
  emitTasks(tasks: TaskState[]): void;
  emitReadChange(change: SseReadChangeFrame): void;
}

export interface LiveEventStream extends TaskEventPublisher {
  onUpdates(listener: () => void): () => void;
  onEvent(listener: (row: EventRow) => void): () => void;
  onTasks(listener: (change: SseTaskChangesFrame | SseTasksFrame) => void): () => void;
  onReadChange(listener: (change: SseReadChangeFrame) => void): () => void;
}
