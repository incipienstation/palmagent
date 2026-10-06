import type { AgentKind } from "@palmagent/shared";
import type { StartArgs, Emit } from "../../../domain/execution.js";
import type { RunHandle } from "../../../domain/run-handle.js";

export interface AgentRunner {
  readonly agent: AgentKind;
  // The adapter spawns/reattaches through the backend (so process+stdio ownership
  // can live in a separate, deploy-surviving daemon) and keeps all CLI-specific
  // parsing/stdin logic here in the web server.
  start(args: StartArgs, emit: Emit, backend: ProcessBackend): RunHandle;
}

// ---------------------------------------------------------------------------
// ProcessBackend owns provider process I/O. RunnerBackend owns application
// execution lifecycle and may delegate it to independent execution hosts.
// ---------------------------------------------------------------------------

export interface SpawnSpec {
  turnId: string; // == taskId (a task has at most one active turn)
  command: string; // "claude" | "codex"
  argv: string[];
  cwd: string;
  env?: Record<string, string | undefined>; // overrides layered onto the backend's environment
}

// A ChildProcess-like shim. stdout is delivered as already-split NDJSON lines,
// each with a per-turn monotonic seq (starting at 1) so reattach can dedup.
export interface ProcHandle {
  readonly turnId: string;
  onLine(cb: (seq: number, line: string) => void): void; // complete NDJSON stdout lines
  onStderr(cb: (text: string) => void): void; // best-effort; not seq'd, not replayed
  onExit(cb: (code: number | null) => void): void; // child exited (turn over)
  stdinWritable(): boolean;
  writeStdin(data: string): boolean; // false if stdin is not writable
  closeStdin(): void;
  kill(signal: "SIGINT" | "SIGTERM" | "SIGKILL"): void;
}

export interface ProcessBackend {
  start(spec: SpawnSpec): ProcHandle;
  attach(turnId: string, fromSeq?: number): ProcHandle | undefined;
}
