import type { CreateRoutineRequest, Routine, UpdateRoutineRequest } from "@palmagent/shared";

/** Independent owner of script definitions, admission, scheduling and result projection. */
export interface ScriptRuntime {
  status(): Promise<{ instance: string; revision: number; activeScripts: number }>;
  create(input: CreateRoutineRequest): Promise<Routine>;
  update(id: string, input: UpdateRoutineRequest): Promise<Routine>;
  remove(id: string): Promise<Routine>;
  run(id: string): Promise<Routine>;
  stop(id: string): Promise<Routine>;
}
