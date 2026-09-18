import type { SubmitMessage, MessageAction, MessageQueue } from "@palmagent/shared";
// Thin REST client for Palmagent. Every shape comes from
// @palmagent/shared — the wire contract is shared with the backend, so
// we never redefine it here. SSE (read) lives in the stream hooks; this file is
// the control plane (REST) only.
import { beginBrowserWork } from "./update-state";
import { clientVersion, observeServerVersion } from "./pwa";
import type {
  AccountLimits,
  SessionHandoffResponse,
  TaskHistoryResponse,
  AgentKind,
  AgentUsage,
  AnswerRequest,
  ApproveRequest,
  AuthMe,
  CreateRepoRequest,
  CreateRoutineRequest,
  CreateTaskRequest,
  DiscoverReposResponse,
  EnrollTokenResponse,
  FollowupRequest,
  FsListResponse,
  Repo,
  RenameTaskRequest,
  Routine,
  RoutineRun,
  SteerRequest,
  SteerResponse,
  TaskState,
  TaskStatus,
  UpdateRoutineRequest,
  UpdateAction,
  UpdateSettingsChange,
  UpdateSettingsStatus,
  ValidateRepoPathResponse,
  RepoSettingsChange,
  RepoSettingsStatus,
} from "@palmagent/shared";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// Auth lives in the service now (in-app WebAuthn — no proxy redirects). An
// unauthenticated /api call returns plain 401 JSON; AuthGate registers a handler
// here so any 401 flips the whole app to the login screen rather than surfacing a
// confusing error. (Login/register/me calls opt out — a 401 there is expected.)
let onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown, opts?: { authProbe?: boolean; signal?: AbortSignal }): Promise<T> {
  const finish = method !== "GET" ? beginBrowserWork() : undefined;
  try {
    const res = await fetch(path, {
      method,
      signal: opts?.signal,
      headers: { "x-palmagent-version": clientVersion, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    observeServerVersion(res.headers.get("x-palmagent-version"));
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      if (res.status === 401 && !opts?.authProbe) onUnauthorized?.();
      // 413 usually comes from the nginx proxy (HTML body, no JSON error).
      if (res.status === 413 && typeof json.error !== "string") {
        throw new ApiError(413, "Request too large for the proxy — shrink/remove images (or raise nginx client_max_body_size).");
      }
      throw new ApiError(res.status, typeof json.error === "string" ? json.error : res.statusText);
    }
    return json as T;
  } finally { finish?.(); }
}

export const api = {
  repoSettings: {
    get: () => request<RepoSettingsStatus>("GET", "/api/settings/repos"),
    change: (change: RepoSettingsChange) => request<RepoSettingsStatus>("PATCH", "/api/settings/repos", change),
  },
  submitMessage: (id: string, req: SubmitMessage) => request<MessageQueue>("POST", `/api/tasks/${encodeURIComponent(id)}/messages`, req),
  messageAction: (id: string, messageId: string, req: MessageAction) => request<MessageQueue>("POST", `/api/tasks/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}`, req),
  resumeQueue: (id: string) => request<MessageQueue>("POST", `/api/tasks/${encodeURIComponent(id)}/queue/resume`, {}),
  updateSettings: {
    action: (action: UpdateAction) => request<UpdateSettingsStatus>("POST", "/api/settings/updates", action),
    get: () => request<UpdateSettingsStatus>("GET", "/api/settings/updates"),
    change: (change: UpdateSettingsChange) => request<UpdateSettingsStatus>("PATCH", "/api/settings/updates", change),
  },
  listRepos: () => request<{ repos: Repo[] }>("GET", "/api/repos").then((r) => r.repos),
  createRepo: (req: CreateRepoRequest) =>
    request<{ repo: Repo }>("POST", "/api/repos", req).then((r) => r.repo),
  deleteRepo: (id: string) =>
    request<{ repo: Repo }>("DELETE", `/api/repos/${encodeURIComponent(id)}`).then((r) => r.repo),

  // ---- repo picker (discovery / browse / validate) ----
  discoverRepos: (refresh = false) =>
    request<DiscoverReposResponse>("GET", `/api/repos/discover${refresh ? "?refresh=1" : ""}`),
  validateRepoPath: (path: string) =>
    request<ValidateRepoPathResponse>("GET", `/api/repos/validate?path=${encodeURIComponent(path)}`),
  listFs: (path?: string) =>
    request<FsListResponse>("GET", `/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ""}`),

  listTasks: (status?: TaskStatus) =>
    request<{ tasks: TaskState[] }>("GET", `/api/tasks${status ? `?status=${status}` : ""}`).then(
      (r) => r.tasks,
    ),
  taskHistory: (id: string, before: number, signal?: AbortSignal) =>
    request<TaskHistoryResponse>("GET", `/api/tasks/${encodeURIComponent(id)}/history?before=${before}`, undefined, { signal }),
  getTask: (id: string) =>
    request<{ task: TaskState }>("GET", `/api/tasks/${encodeURIComponent(id)}`).then((r) => r.task),
  getAccountLimits: (id: string) => request<AccountLimits>("GET", `/api/tasks/${encodeURIComponent(id)}/account-limits`),
  createTask: (req: CreateTaskRequest) =>
    request<{ task: TaskState }>("POST", "/api/tasks", req).then((r) => r.task),
  renameTask: (id: string, req: RenameTaskRequest) =>
    request<{ task: TaskState }>("PATCH", `/api/tasks/${encodeURIComponent(id)}`, req).then((r) => r.task),

  // ---- usage (per-agent aggregate over the result event log) ----
  getUsage: () => request<{ usage: AgentUsage[] }>("GET", "/api/usage").then((r) => r.usage),

  followup: (id: string, req: FollowupRequest) =>
    request<{ task: TaskState }>(
      "POST",
      `/api/tasks/${encodeURIComponent(id)}/followup`,
      req,
    ).then((r) => r.task),
  steer: (id: string, req: SteerRequest) =>
    request<SteerResponse>("POST", `/api/tasks/${encodeURIComponent(id)}/steer`, req),
  approve: (id: string, req: ApproveRequest) =>
    request<{ task: TaskState }>(
      "POST",
      `/api/tasks/${encodeURIComponent(id)}/approve`,
      req,
    ).then((r) => r.task),
  // Answer a pending AskUserQuestion (task is awaiting_input).
  answer: (id: string, req: AnswerRequest) =>
    request<{ task: TaskState }>(
      "POST",
      `/api/tasks/${encodeURIComponent(id)}/answer`,
      req,
    ).then((r) => r.task),
  handoff: (id: string) => request<SessionHandoffResponse>("POST", `/api/tasks/${encodeURIComponent(id)}/handoff`),
  stop: (id: string) =>
    request<{ task: TaskState }>("POST", `/api/tasks/${encodeURIComponent(id)}/stop`).then(
      (r) => r.task,
    ),
  cancel: (id: string) =>
    request<{ task: TaskState }>("POST", `/api/tasks/${encodeURIComponent(id)}/cancel`).then(
      (r) => r.task,
    ),
  archive: (id: string) =>
    request<{ task: TaskState }>("DELETE", `/api/tasks/${encodeURIComponent(id)}`).then(
      (r) => r.task,
    ),

  // ---- routines ----
  listRoutines: () => request<{ routines: Routine[] }>("GET", "/api/routines").then((r) => r.routines),
  createRoutine: (req: CreateRoutineRequest) =>
    request<{ routine: Routine }>("POST", "/api/routines", req).then((r) => r.routine),
  updateRoutine: (id: string, req: UpdateRoutineRequest) =>
    request<{ routine: Routine }>("PATCH", `/api/routines/${encodeURIComponent(id)}`, req).then(
      (r) => r.routine,
    ),
  deleteRoutine: (id: string) =>
    request<{ routine: Routine }>("DELETE", `/api/routines/${encodeURIComponent(id)}`).then(
      (r) => r.routine,
    ),
  runRoutine: (id: string) =>
    request<{ routine: Routine }>("POST", `/api/routines/${encodeURIComponent(id)}/run`).then(
      (r) => r.routine,
    ),
  routineRuns: (id: string) =>
    request<{ runs: RoutineRun[] }>("GET", `/api/routines/${encodeURIComponent(id)}/runs`).then(
      (r) => r.runs,
    ),

  // ---- auth (in-app WebAuthn / passkeys) ----
  // The options/response payloads are passed through verbatim from/to the browser
  // WebAuthn library. me/login/register opt out of the global 401 handler — a 401
  // there is part of the login flow, not a session that just expired.
  auth: {
    me: () => request<AuthMe>("GET", "/api/auth/me", undefined, { authProbe: true }),
    loginOptions: () =>
      request<PublicKeyCredentialRequestOptionsJSON>("POST", "/api/auth/login/options", undefined, {
        authProbe: true,
      }),
    loginVerify: (response: AuthenticationResponseJSON) =>
      request<{ ok: true }>("POST", "/api/auth/login/verify", response, { authProbe: true }),
    registerOptions: (token?: string) =>
      request<PublicKeyCredentialCreationOptionsJSON>("POST", "/api/auth/register/options", { token }, {
        authProbe: true,
      }),
    registerVerify: (response: RegistrationResponseJSON, label?: string) =>
      request<{ ok: true }>("POST", "/api/auth/register/verify", { response, label }, { authProbe: true }),
    logout: () => request<{ ok: true }>("POST", "/api/auth/logout", undefined, { authProbe: true }),
    enrollToken: () => request<EnrollTokenResponse>("POST", "/api/auth/enroll-token"),
  },
};

// EventSource only surfaces an opaque error, never a 401, so on a stream failure
// the hooks call this to tell "logged out" (→ show login) apart from a transient
// network/proxy blip (→ keep reconnecting).
export async function probeAuth(): Promise<void> {
  try {
    const me = await api.auth.me();
    if (me.required && !me.authenticated) onUnauthorized?.();
  } catch {
    /* network hiccup — not an auth problem */
  }
}

// Per-agent permission catalog + per-agent default live in the shared contract
// (the server maps each value to CLI flags). Re-exported here so the forms keep
// importing it from "../api" alongside MODELS/EFFORTS.
export { PERMISSIONS, DEFAULT_PERMISSION } from "@palmagent/shared";
export type { PermissionOption } from "@palmagent/shared";

// Model choices for dispatch, follow-ups, and routines. Default delegates to the
// server/CLI. Codex availability depends on the account and installed client.
export const DEFAULT_OPTION = "default";

export const MODELS: Record<AgentKind, { value: string; label: string }[]> = {
  claude: [
    { value: DEFAULT_OPTION, label: "default" },
    { value: "opus", label: "opus" },
    { value: "sonnet", label: "sonnet" },
    { value: "haiku", label: "haiku" },
  ],
  codex: [
    { value: DEFAULT_OPTION, label: "default" },
    { value: "gpt-6-astra", label: "gpt-6-astra" },
    { value: "gpt-5.6", label: "gpt-5.6" },
    { value: "gpt-5.6-sol", label: "gpt-5.6-sol" },
    { value: "gpt-5.6-terra", label: "gpt-5.6-terra" },
    { value: "gpt-5.6-luna", label: "gpt-5.6-luna" },
    { value: "gpt-5.3-codex-spark", label: "gpt-5.3-codex-spark" },
    { value: "gpt-5.5", label: "gpt-5.5" },
  ],
};

export const EFFORTS: Record<AgentKind, { value: string; label: string }[]> = {
  claude: [
    { value: DEFAULT_OPTION, label: "default" },
    { value: "low", label: "low" },
    { value: "medium", label: "medium" },
    { value: "high", label: "high" },
    { value: "xhigh", label: "xhigh" },
    { value: "max", label: "max" },
  ],
  codex: [
    { value: DEFAULT_OPTION, label: "default" },
    { value: "low", label: "low" },
    { value: "medium", label: "medium" },
    { value: "high", label: "high" },
    { value: "xhigh", label: "xhigh" },
  ],
};

// Verified against Codex CLI 0.154.0's model catalog (2026-09-18).
// https://learn.chatgpt.com/docs/models describes Max and Ultra semantics.
// The gpt-5.6 alias targets Sol: https://developers.openai.com/api/docs/models/gpt-5.6-sol
// Default/unknown models use common efforts because the CLI resolves their model.
const CODEX_EXTENDED_EFFORTS: Record<string, string[]> = {
  "gpt-6-astra": ["max", "ultra"],
  "gpt-5.6": ["max", "ultra"],
  "gpt-5.6-sol": ["max", "ultra"],
  "gpt-5.6-terra": ["max", "ultra"],
  "gpt-5.6-luna": ["max"],
};

export function effortsForModel(agent: AgentKind, model: string) {
  return agent === "codex"
    ? [...EFFORTS.codex, ...(CODEX_EXTENDED_EFFORTS[model] ?? []).map((value) => ({ value, label: value }))]
    : EFFORTS.claude;
}

export function selectableModel(agent: AgentKind, model: string): string {
  return agent === "codex" && (model === "gpt-5.4" || model === "gpt-5.4-mini") ? DEFAULT_OPTION : model;
}

export function selectableEffort(agent: AgentKind, model: string, effort: string): string {
  return effortsForModel(agent, model).some((option) => option.value === effort) ? effort : DEFAULT_OPTION;
}
