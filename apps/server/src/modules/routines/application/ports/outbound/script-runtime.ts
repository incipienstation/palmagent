import type { CreateRoutineRequest, Routine, RoutineRun, UpdateRoutineRequest } from "@palmagent/shared";

/** Independent owner of script definitions, admission, scheduling and result projection. */
export interface ScriptRuntime {
  status(): Promise<{ instance: string; revision: number; activeScripts: number }>;
  list(): Promise<Routine[]>;
  get(id: string): Promise<Routine>;
  create(input: CreateRoutineRequest): Promise<Routine>;
  update(id: string, input: UpdateRoutineRequest): Promise<Routine>;
  remove(id: string): Promise<Routine>;
  run(id: string): Promise<Routine>;
  stop(id: string): Promise<Routine>;
  runs(id: string): Promise<RoutineRun[]>;
}
