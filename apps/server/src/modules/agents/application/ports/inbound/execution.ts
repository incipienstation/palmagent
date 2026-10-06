import type { AgentKind } from "@palmagent/shared";
import type { StartArgs, Emit, ExecutionControlState } from "../../../domain/execution.js";
import type { RunHandle } from "../../../domain/run-handle.js";

export interface ExecutionRunner {
  readonly agent: AgentKind;
  start(args: StartArgs, emit: Emit): RunHandle;
}

export interface RunnerBackend {
  readonly independent?: boolean;
  saveControl?(taskId: string, state: ExecutionControlState): void;
  loadControl?(taskId: string): ExecutionControlState | undefined;
  agentRunner(agent: AgentKind): ExecutionRunner;
  // Disconnect this client / stop locally owned children; never stop daemon-owned turns.
  close?(): void | Promise<void>;
  // Optional connect step (DaemonBackend dials the socket). Resolves false if the
  // backend could not become ready (caller may fall back to InProcessBackend).
  init?(): Promise<boolean>;
  listLive(): Promise<string[]>; // turnIds still alive — drives restart recovery
  // Tell the backend the turn is fully consumed so it can drop its replay buffer.
  release?(turnId: string): void;
}
