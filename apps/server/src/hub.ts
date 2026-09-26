import type { SseReadChangeFrame, TaskState } from "@palmagent/shared";
import type { EventRow } from "./application/models.js";
import type { LiveEventStream } from "./application/ports.js";

// In-process fan-out to connected SSE clients. The DB is the durable log (and
// replay source); the Hub is only the live push. Each persisted event arrives
// here as an EventRow carrying both the global id and per-task seq so the SSE
// handler can pick the right `id:` for its stream kind.
type EventListener = (row: EventRow) => void;
type TasksListener = (tasks: TaskState[]) => void;

export class Hub implements LiveEventStream {
  private updateSubs = new Set<() => void>();
  onUpdates(listener: () => void): () => void {
    this.updateSubs.add(listener);
    return () => { this.updateSubs.delete(listener); };
  }
  emitUpdates(): void {
    for (const listener of this.updateSubs) { try { listener(); } catch { /* isolate subscribers */ } }
  }

  private eventSubs = new Set<EventListener>();
  private tasksSubs = new Set<TasksListener>();
  private readSubs = new Set<(change: SseReadChangeFrame) => void>();

  onEvent(l: EventListener): () => void {
    this.eventSubs.add(l);
    return () => this.eventSubs.delete(l);
  }
  onTasks(l: TasksListener): () => void {
    this.tasksSubs.add(l);
    return () => this.tasksSubs.delete(l);
  }
  onReadChange(l: (change: SseReadChangeFrame) => void): () => void {
    this.readSubs.add(l);
    return () => this.readSubs.delete(l);
  }

  // One misbehaving subscriber (e.g. a write to a dead socket) must not break
  // fan-out to the others, nor throw back into the event-ingest path.
  emitEvent(row: EventRow): void {
    for (const l of this.eventSubs) {
      try {
        l(row);
      } catch {
        /* isolate this subscriber */
      }
    }
  }
  emitTasks(tasks: TaskState[]): void {
    for (const l of this.tasksSubs) {
      try {
        l(tasks);
      } catch {
        /* isolate this subscriber */
      }
    }
  }
  emitReadChange(change: SseReadChangeFrame): void {
    for (const l of this.readSubs) {
      try { l(change); } catch { /* isolate subscribers */ }
    }
  }
}
