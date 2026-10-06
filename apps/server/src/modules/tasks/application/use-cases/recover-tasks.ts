import type { TaskRepository } from "../ports/outbound/persistence.js";

/** Only turns without a surviving execution become interrupted, resumable tasks. */
export function recoverTasks(repository: Pick<TaskRepository, "inFlightTaskIds" | "resetInterruptedTasks">, now: number, keep?: ReadonlySet<string>): string[] {
  const ids = repository.inFlightTaskIds().filter(id => !keep?.has(id));
  if (ids.length) repository.resetInterruptedTasks(ids, now);
  return ids;
}
