import type { CreateTaskRequest, CreateRoutineRequest, Routine, UpdateRoutineRequest } from "@palmagent/shared";

export interface AgentDispatch { id: number; task: CreateTaskRequest }
export interface RoutineStatus { instance: string; revision: number; activeScripts: number }
export interface DispatchSettlement { status?: RoutineStatus; next?: AgentDispatch | null }
export interface RoutineAdmission { routine: Routine; dispatch?: AgentDispatch }

/** Independent routine owner. The API delivers durable agent requests to Tasks. */
export interface RoutineRuntime {
  status(): Promise<RoutineStatus>;
  create(input: CreateRoutineRequest): Promise<Routine>;
  update(id: string, input: UpdateRoutineRequest): Promise<Routine>;
  remove(id: string): Promise<Routine>;
  run(id: string): Promise<RoutineAdmission>;
  agentTick(startup: boolean): Promise<AgentDispatch | null>;
  nextDispatch(): Promise<AgentDispatch | null>;
  settleDispatch(id: number, receipt: { taskId?: string; note?: string }, includeNext: boolean): Promise<DispatchSettlement>;
  stop(id: string): Promise<Routine>;
}
