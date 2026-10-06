import type { Repo, Routine, RoutineRun, TaskState } from "@palmagent/shared";

export interface RoutineRepository {
  getRepo(id: string): Repo | undefined;
  listRepos(): Repo[];
  transaction<T>(work: () => T): T;
  interruptRoutineRuns(): void;
  listRoutines(): Routine[];
  updateRoutine(routine: Routine): void;
  insertRoutineRun(run: Omit<RoutineRun, "id">): number;
  insertRoutine(routine: Routine): void;
  getRoutine(id: string): Routine | undefined;
  deleteRoutine(id: string): void;
  hasRunningRoutine(repoId: string): boolean;
  listRoutineRuns(id: string, limit?: number): RoutineRun[];
  finishRoutineRun(id: number, result: Pick<RoutineRun, "status" | "note" | "finishedAt" | "exitCode" | "output" | "worktreePath">): void;
}

export type RoutineScriptResult = Pick<RoutineRun, "status" | "note" | "finishedAt" | "exitCode" | "output" | "worktreePath">;

export interface RoutineScriptExecution {
  stop(reason?: string): void;
  done: Promise<RoutineScriptResult>;
}

export interface PreparedRoutineScript {
  worktreePath?: string;
  start(): RoutineScriptExecution;
}

export interface RoutineScriptRunner {
  prepare(repo: Repo, script: NonNullable<Routine["script"]>): PreparedRoutineScript;
}

export interface RoutineTaskUseCases {
  readonly updating: boolean;
  createTask(input: import("@palmagent/shared").CreateTaskRequest): TaskState;
}
