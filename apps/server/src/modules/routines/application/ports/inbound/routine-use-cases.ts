import type { Repo } from "@palmagent/shared";
import type { CreateRoutineRequest, Routine, RoutineRun, UpdateRoutineRequest } from "@palmagent/shared";

/** Operations accepted by the routines module. */
export interface RoutineUseCases {
  start(): void;
  stop(): Promise<void>;
  create(req: CreateRoutineRequest): Routine;
  context(): { repos: Repo[]; timezone: string; };
  list(): Routine[];
  get(id: string): Routine;
  update(id: string, req: UpdateRoutineRequest): Routine;
  remove(id: string): Routine;
  runNow(id: string): Routine;
  stopRun(id: string): Promise<Routine>;
  runs(id: string, limit?: number): RoutineRun[];
}
