// Backend-only interfaces. The data contracts (AgentEvent, TaskState, Repo, REST
// DTOs, SSE frames) live in @palmagent/shared so the PWA can reuse them.
import type { AgentEvent, AgentKind, AnswerRequest, ImageAttachment, Permission, QuestionRequest } from "@palmagent/shared";

export interface StartArgs {
  taskId: string;
  cwd: string; // the task's worktree path — stable for the task's whole life
  prompt: string;
  images?: ImageAttachment[]; // attached to the opening user message of the turn
  resumeId?: string; // present => resume an existing session/thread by id
  permission?: Permission; // mapped per adapter; agent-specific safe default
  model?: string; // optional model override
  effort?: string; // optional reasoning-effort override (claude --effort / codex model_reasoning_effort)
  // Reattach to a turn already running in the runner daemon (after a web-server
  // restart). The adapter consumes the replayed stream but does NOT (re)send the
  // opening prompt — the live turn already received it. `resumeFromSeq` is the
  // task's persisted line high-water-mark so already-emitted events are dropped.
  reattach?: boolean;
  resumeFromSeq?: number;
  // On reattach to a turn paused on AskUserQuestion: the task's persisted pending
  // question. The daemon won't replay the original can_use_tool line (its seq is
  // at/below the high-water-mark), so the adapter re-seeds its requestId→questions
  // map from this — otherwise answering the turn fails after a web-server restart.
  // Claude-only; undefined on fresh starts and for turns not paused on a question.
  pendingInput?: QuestionRequest;
}

// A live, in-flight turn. The process is held open only for its duration.
export interface RunHandle {
  steer: (text: string, images?: ImageAttachment[]) => boolean; // mid-turn message; false if the CLI can't inject one
  interrupt: () => boolean; // graceful mid-turn stop; false if the CLI has no channel (caller falls back to cancel())
  approve: (decision: string, scope?: string) => boolean; // false if the CLI has no approval channel
  answer: (req: AnswerRequest) => boolean; // answer a pending AskUserQuestion; false if no matching pending request
  cancel: () => void; // SIGINT to the child
  done: Promise<void>; // resolves when the child exits (turn over)
}

// Adapters emit events without `agent`/`ts`; the service stamps those. The
// optional rawSeq is the source NDJSON line's per-turn sequence — it never rides
// the wire AgentEvent; the service uses it for exactly-once persistence on
// reattach (drop events whose rawSeq <= the task's persisted high-water-mark).
export type RawEvent = Omit<AgentEvent, "agent" | "ts">;
export type Emit = (e: RawEvent, rawSeq?: number) => void;

export interface AgentRunner {
  readonly agent: AgentKind;
  // The adapter spawns/reattaches through the backend (so process+stdio ownership
  // can live in a separate, deploy-surviving daemon) and keeps all CLI-specific
  // parsing/stdin logic here in the web server.
  start(args: StartArgs, emit: Emit, backend: RunnerBackend): RunHandle;
}

// ---------------------------------------------------------------------------
// RunnerBackend: the seam between the adapters (which own CLI knowledge) and
// whoever owns the actual child processes + stdio. Two impls: InProcessBackend
// (spawns locally in development) and DaemonBackend (proxies to
// the long-lived runner daemon over a Unix socket — production survival).
// ---------------------------------------------------------------------------

export interface SpawnSpec {
  turnId: string; // == taskId (a task has at most one active turn)
  command: string; // "claude" | "codex"
  argv: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
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
  kill(signal: NodeJS.Signals): void;
}

export interface RunnerBackend {
  // Optional connect step (DaemonBackend dials the socket). Resolves false if the
  // backend could not become ready (caller may fall back to InProcessBackend).
  init?(): Promise<boolean>;
  start(spec: SpawnSpec): ProcHandle; // spawn a brand-new turn
  // Reattach to a turn still running in the backend; undefined if it isn't live.
  attach(turnId: string, fromSeq?: number): ProcHandle | undefined;
  listLive(): Promise<string[]>; // turnIds still alive — drives restart recovery
  // Tell the backend the turn is fully consumed so it can drop its replay buffer.
  release?(turnId: string): void;
}
