// Wire protocol between the dispatcher backend and clients (the PWA, demo, and
// operator tooling). The browser reads with SSE and controls tasks with REST.
import type { AgentEvent, AgentKind } from "./events.js";
import type { Permission, Repo, Routine, RoutinePreset, RoutineRun, TaskState } from "./task.js";

// ---- REST request bodies ----
export interface CreateRepoRequest {
  path: string;
  name?: string;
  defaultBaseRef?: string; // defaults to the repo's current branch
}
// An image the user attached to a prompt (pasted or picked in the PWA).
// Claude gets it as a base64 image content block; Codex as a temp file via -i.
export interface ImageAttachment {
  mediaType: string; // image/png | image/jpeg | image/webp | image/gif
  data: string; // base64, no data: URL prefix
}
export interface CreateTaskRequest {
  repoId: string;
  agent: AgentKind;
  prompt: string;
  permission?: Permission; // per-agent value; defaults to DEFAULT_PERMISSION[agent]
  model?: string;
  effort?: string; // reasoning effort (claude --effort / codex model_reasoning_effort)
  title?: string;
  images?: ImageAttachment[];
  // Run this git task in an isolated per-task worktree+branch instead
  // of directly in the repo. Default false = run in place. Ignored for plain
  // folders (vcs "none"), which always run in place.
  isolate?: boolean;
}
export interface FollowupRequest {
  prompt: string;
  images?: ImageAttachment[];
  // Override the task's model / reasoning effort / permission for this and every
  // later turn. Omitted = keep the task's current setting (the common case); "" =
  // reset to the agent's default (clear the override). All three are per-agent.
  model?: string;
  effort?: string;
  permission?: Permission;
}
export interface SteerRequest {
  text: string;
  images?: ImageAttachment[];
  // Change the model / reasoning effort / permission for the steered (and every
  // later) turn. Omitted = keep the current setting; "" = reset to the agent's
  // default. A change can't be applied to a process already running, so a Claude
  // turn is interrupted and resumed with the new flags (see SteerResponse.restarted);
  // Codex picks them up on its next turn.
  model?: string;
  effort?: string;
  permission?: Permission;
}
export interface ApproveRequest {
  decision: "approve" | "deny";
  scope?: string;
}
// The user's answer to a Claude AskUserQuestion (the task is `awaiting_input`).
// One entry per question asked; `selected` holds the chosen option label(s)
// (empty = that question was skipped), `notes` an optional free-text custom
// answer. `requestId` must match the pending question's id.
export interface QuestionAnswer {
  question: string; // the question text (the CLI's answer key)
  selected: string[]; // chosen option label(s); [] when skipped
  notes?: string; // optional free-text note / custom answer
}
export interface AnswerRequest {
  requestId: string;
  answers: QuestionAnswer[];
  response?: string; // optional overall free-text reply
}

// ---- REST response bodies ----
export interface ReposResponse {
  repos: Repo[];
}
export interface TasksResponse {
  tasks: TaskState[];
}
export interface TaskResponse {
  task: TaskState;
}
export interface SteerResponse {
  injected: boolean; // true = interrupted mid-turn (Claude); false = queued as next turn (Codex)
  queued: boolean;
  restarted?: boolean; // the active turn was interrupted to resume with a new model/effort
}
export interface ErrorResponse {
  error: string;
}

// ---- Usage stats (per-agent aggregate over the result event log) ----
// The two CLIs report asymmetric usage and bury it in `result` events: Claude
// emits a USD cost + duration + turn count; Codex emits token counts (no cost).
// A consumer renders whichever metrics each agent actually reports — a zero
// field means "not reported by that CLI", not "no usage".
export interface AgentUsage {
  agent: AgentKind;
  taskCount: number; // tasks ever dispatched to this agent (any final status)
  turnCount: number; // completed turns (one result event each)
  totalCostUsd: number; // Σ total_cost_usd (Claude)
  durationMs: number; // Σ duration_ms (Claude) — wall-clock spent in turns
  inputTokens: number; // Σ usage.input_tokens (Codex)
  cachedInputTokens: number; // Σ usage.cached_input_tokens (Codex; subset of input)
  outputTokens: number; // Σ usage.output_tokens (Codex)
  reasoningOutputTokens: number; // Σ usage.reasoning_output_tokens (Codex; subset of output)
}
export interface UsageResponse {
  usage: AgentUsage[]; // one row per agent kind that has at least one task
}

// ---- Repo discovery & path picking (mobile-first "Add a repo" picker) ----
// Tap-first registration: GET /api/repos/discover lists git repos found under
// the configured scan roots (REPO_ROOTS), GET /api/fs/list backs the drill-down
// folder browser, and GET /api/repos/validate pre-checks a manually typed path
// before registration (✓ state, root snapping, "did you mean" suggestions).
export interface DiscoveredRepo {
  path: string; // absolute work-tree root
  name: string; // basename(path)
  branch: string; // current HEAD branch ("HEAD" when detached/unknown)
  lastActivityAt: number; // mtime of .git/HEAD — proxy for "recently worked on"
  repoId?: string; // present when this path is already registered
}
export interface DiscoverReposResponse {
  repos: DiscoveredRepo[]; // sorted by lastActivityAt desc
  roots: string[];
  scannedAt: number;
}
export interface ValidateRepoPathResponse {
  input: string;
  resolved: string; // after ~ expansion + path resolution
  exists: boolean;
  isDir: boolean; // an existing directory — registrable even without git (as a plain folder)
  isGit: boolean;
  root?: string; // git toplevel — differs from `resolved` for paths inside a repo
  branch?: string;
  repoId?: string; // already registered under this id
  suggestions: string[]; // closest discovered repo roots when the path is invalid
}
export interface FsEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}
export interface FsListResponse {
  path: string; // the listed directory (resolved)
  parent?: string; // absent at the filesystem root
  root?: string; // git toplevel containing `path`, when inside a repo
  entries: FsEntry[]; // child directories only (dotdirs + node_modules hidden)
}

// ---- Routines ----
export interface CreateRoutineRequest {
  repoId: string;
  agent: AgentKind;
  prompt: string;
  // Cadence. `preset` (default "custom") picks how the schedule is built:
  // friendly presets compile to cron server-side using `hour`/`dayOfWeek`;
  // "manual" never auto-fires; "custom" (or omitted) uses the raw `schedule`.
  preset?: RoutinePreset;
  schedule?: string; // 5-field cron — required for "custom"/omitted, ignored otherwise
  hour?: number; // 0-23, for daily/weekly/weekdays (default 9)
  dayOfWeek?: number; // 0-6 (Sun-Sat), for weekly (default 1 = Monday)
  permission?: Permission;
  model?: string;
  effort?: string;
  title?: string;
}
export interface UpdateRoutineRequest {
  prompt?: string;
  preset?: RoutinePreset;
  schedule?: string;
  hour?: number;
  dayOfWeek?: number;
  permission?: Permission;
  model?: string;
  effort?: string;
  title?: string;
  enabled?: boolean;
}
export interface RoutinesResponse {
  routines: Routine[];
}
export interface RoutineResponse {
  routine: Routine;
}
export interface RoutineRunsResponse {
  runs: RoutineRun[]; // most-recent first
}

// ---- Web Push ----
// The browser's PushSubscription.toJSON() shape; kept loose on purpose so the
// client can pass it through without re-validation.
export interface PushSubscriptionJson {
  endpoint: string;
  expirationTime?: number | null;
  keys?: Record<string, string>;
}
export interface PushKeyResponse {
  publicKey: string; // VAPID public key (base64url) for pushManager.subscribe
}
export interface PushSubscribeRequest {
  subscription: PushSubscriptionJson;
}
export interface PushUnsubscribeRequest {
  endpoint: string;
}
// The payload a push message carries (sw.ts shows it as a notification).
export interface PushPayload {
  title: string;
  body: string;
  taskId?: string;
  url?: string; // SPA route to open on notification click, e.g. "/#/task/t123"
}

// ---- SSE frames (the `data:` payload carried over text/event-stream) ----
// Each frame is sent as a named SSE event. `event` frames also carry an `id:`
// line — the global events.id on the inbox stream (`/api/stream`) or the
// per-task seq on a scoped stream (`/api/stream?task=:id`) — so EventSource
// replays via Last-Event-ID on reconnect. `tasks` frames carry no id (they are
// state snapshots, not log entries) and a fresh one is sent on every connect.
export interface SseEventFrame {
  type: "event";
  event: AgentEvent;
}
export interface SseTasksFrame {
  type: "tasks";
  tasks: TaskState[];
}
export type SseFrame = SseEventFrame | SseTasksFrame;

// ---- auth (in-app WebAuthn / passkeys) ----
// GET /api/auth/me. The WebAuthn options/response payloads (login/register) are
// the library's own JSON shapes and are passed through opaquely, so they are not
// redefined here.
export interface AuthMe {
  authenticated: boolean;
  // False when the server doesn't enforce auth (dev/demo) — the client then skips
  // the login gate entirely.
  required: boolean;
  credentialCount: number;
}
export interface EnrollTokenResponse {
  token: string;
  expiresAt: number;
}
