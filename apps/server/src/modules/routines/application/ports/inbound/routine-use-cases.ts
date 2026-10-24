import type { Repo } from "@palmagent/shared";
import type { CreateRoutineRequest, Routine, RoutineRun, UpdateRoutineRequest } from "@palmagent/shared";

/** Operations accepted by the routines module. */
export interface RoutineUseCases {
  readonly activeScriptCount?: number;
  readonly updateBlockingScriptCount?: number;
  start(): void;
  stop(): Promise<void>;
  create(req: CreateRoutineRequest): Routine | Promise<Routine>;
  context(): { repos: Repo[]; timezone: string; };
  list(): Routine[] | Promise<Routine[]>;
  get(id: string): Routine | Promise<Routine>;
  update(id: string, req: UpdateRoutineRequest): Routine | Promise<Routine>;
  remove(id: string): Routine | Promise<Routine>;
  runNow(id: string): Routine | Promise<Routine>;
  stopRun(id: string): Promise<Routine>;
  runs(id: string, limit?: number): RoutineRun[] | Promise<RoutineRun[]>;
}
