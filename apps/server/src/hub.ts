import type { TaskState } from "@palmagent/shared";
import type { EventRow } from "./db.js";

// In-process fan-out to connected SSE clients. The DB is the durable log (and
// replay source); the Hub is only the live push. Each persisted event arrives
// here as an EventRow carrying both the global id and per-task seq so the SSE
// handler can pick the right `id:` for its stream kind.
type EventListener = (row: EventRow) => void;
type TasksListener = (tasks: TaskState[]) => void;

export class Hub {
  private eventSubs = new Set<EventListener>();
  private tasksSubs = new Set<TasksListener>();

  onEvent(l: EventListener): () => void {
    this.eventSubs.add(l);
    return () => this.eventSubs.delete(l);
  }
  onTasks(l: TasksListener): () => void {
    this.tasksSubs.add(l);
    return () => this.tasksSubs.delete(l);
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
}
