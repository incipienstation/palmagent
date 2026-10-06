import type { AgentEvent, InputAttachment, Permission, PermissionRequest, QuestionRequest } from "@palmagent/shared";

export interface StartArgs {
  taskId: string;
  messageId?: string;
  interactive?: boolean;
  cwd: string; // the task's worktree path — stable for the task's whole life
  prompt: string;
  skills?: import("@palmagent/shared").SkillSelection[];
  images?: InputAttachment[]; // attached to the opening user message of the turn
  providerHome?: string; // pinned native transcript/config root for this session
  resumeId?: string; // present => resume an existing session/thread by id
  permission?: Permission; // mapped per adapter; agent-specific safe default
  model?: string; // optional model override
  effort?: string; // optional reasoning-effort override (claude --effort / codex model_reasoning_effort)
  // Reattach to a turn already running in the runner daemon (after a web-server
  // restart). The adapter consumes the replayed stream but does NOT (re)send the
  // opening prompt — the live turn already received it. `resumeFromSeq` is the
  // task's persisted line high-water-mark. Replay starts at zero to reconstruct
  // terminal state, while persisted effects are suppressed using this baseline.
  reattach?: boolean;
  resumeFromSeq?: number;
  // On reattach to a turn paused on AskUserQuestion: the task's persisted pending
  // question. Historical control requests are skipped, so the adapter re-seeds
  // its requestId→questions map from this without reviving answered questions.
  // Undefined on fresh starts and for turns not paused on a question.
  pendingInput?: QuestionRequest;
  // Same recovery boundary for a provider permission request. The active
  // execution backend normally retains this in memory; the task copy lets the
  // web service render the request and re-seed in-process/daemon adapters.
  pendingApproval?: PermissionRequest;
}

// Adapters emit events without `agent`/`ts`; the service stamps those. The
// optional rawSeq is the source NDJSON line's per-turn sequence — it never rides
// the wire AgentEvent; the service uses it for exactly-once persistence on
// reattach (drop events whose rawSeq <= the task's persisted high-water-mark).
export type RawEvent = { [K in AgentEvent["kind"]]: Omit<AgentEvent<K>, "agent" | "ts"> }[AgentEvent["kind"]];

export type Emit = (e: RawEvent, rawSeq?: number) => void;

export interface ExecutionControlState { stopping: boolean; steerRestart: boolean; pendingSteer: Array<{ text: string; images: InputAttachment[] }> }
