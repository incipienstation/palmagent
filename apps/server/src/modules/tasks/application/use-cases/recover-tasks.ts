import type { TaskState } from "@palmagent/shared";
import type { RunnerBackend } from "../../../agents/api.js";
import type { TaskRepository } from "../ports/outbound/persistence.js";

/** Only turns without a surviving execution become interrupted, resumable tasks. */
export function recoverTasks(repository: Pick<TaskRepository, "inFlightTaskIds" | "resetInterruptedTasks">, now: number, keep?: ReadonlySet<string>): string[] {
  const ids = repository.inFlightTaskIds().filter(id => !keep?.has(id));
  if (ids.length) repository.resetInterruptedTasks(ids, now);
  return ids;
}

interface RecoveryEffects {
  reattach(task: TaskState): void;
  recoverMessages(taskId: string, live: boolean): void;
  now(): number;
}

/** Reattach first, reset only proven orphans, then recover every message queue. */
export async function recoverTaskExecutions(
  repository: Pick<TaskRepository, "inFlightTaskIds" | "resetInterruptedTasks" | "messageTaskIds">,
  backend: Pick<RunnerBackend, "independent" | "listLive">,
  tasks: ReadonlyMap<string, TaskState>, effects: RecoveryEffects,
): Promise<{ reattached: string[]; recovered: string[] }> {
  const shared = [...tasks.values()].filter(task => task.sessionControl?.owner === "shared");
  const inFlight = new Set(repository.inFlightTaskIds().filter(id => tasks.get(id)?.sessionControl?.owner !== "shared"));
  let live: string[] = [];
  if (inFlight.size || backend.independent) {
    try {
      live = (await backend.listLive()).filter(id => inFlight.has(id) || (backend.independent && tasks.get(id)?.status === "cancelled"));
    } catch (error) {
      if (backend.independent) throw error;
    }
  }
  if (backend.independent && [...inFlight].some(id => !live.includes(id))) {
    throw new Error("An in-flight task has no execution identity; refusing automatic recovery");
  }
  const reattached: string[] = [];
  for (const id of live) {
    const task = tasks.get(id);
    // Legacy queued tasks have no live session; independent hosts retain their admission.
    if (task && (["running", "awaiting_approval", "awaiting_input"].includes(task.status)
      || backend.independent && (task.status === "queued" || task.status === "cancelled"))) {
      try { effects.reattach(task); reattached.push(id); }
      catch (error) { if (backend.independent) throw error; }
    }
  }
  const keep = new Set([...reattached, ...shared.map(task => task.taskId)]);
  const recovered = recoverTasks(repository, effects.now(), keep);
  for (const id of recovered) {
    const task = tasks.get(id);
    if (task) { task.status = "idle"; task.interrupted = true; }
  }
  for (const id of repository.messageTaskIds()) effects.recoverMessages(id, keep.has(id));
  return { reattached, recovered };
}
