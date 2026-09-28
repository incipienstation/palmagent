import type { RoutineRun } from "./task.js";
export const ROUTINE_POLICY = { defaultTimeoutSeconds: 300, maxTimeoutSeconds: 3600, maxCommandLength: 16_000,
  scriptConcurrency: 4, defaultHour: 9, defaultDayOfWeek: 1 } as const;
/** Compatibility at the read boundary for history and older servers without reason codes. */
export function routineRunReason(run: Pick<RoutineRun, "reason" | "note">): RoutineRun["reason"] {
  return run.reason ?? (run.note === "missed while the server was down" ? "missed_while_down" : undefined);
}
