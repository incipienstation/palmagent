import { attachmentFetch, snapshotRequest } from "./attachment-request";
import type { CreateTerminalRequest } from "@palmagent/shared/terminals";
import { cacheSession, invalidateClientReads, type ClientReadScope } from "./query-lifecycle";
import { hc } from "hono/client";
import type { AppType } from "@palmagent/server/http-api";
import type { ApiErrorResponse } from "@palmagent/shared/http";
import { MESSAGE_PROTOCOL_HEADER, MESSAGE_PROTOCOL_VERSION, TURN_CONTROL_HEADER, TURN_CONTROL_VERSION } from "@palmagent/shared/http";
import { recoverUpdateRead } from "./update-recovery";
import { retryMessage } from "./message-retry";
import type {
  AgentKind, AnswerRequest, ApproveRequest, CreateRepoRequest, CreateRoutineRequest,
  CreateTaskRequest, FollowupRequest, InputAttachment, MessageAction, PushSubscribeRequest,
  RenameTaskRequest, RepoSettingsChange, SteerRequest, SubmitMessage, TaskStatus, TaskState, MessageQueue,
  UpdateAction, UpdateRepoRequest, UpdateRoutineRequest, UpdateSettingsChange,
} from "@palmagent/shared";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/browser";

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: ApiErrorResponse["code"]) {
    super(message);
    this.name = "ApiError";
  }
}

interface ApiLifecycle {
  version(): string;
  observeServerVersion(version: string | null): void;
  beginBrowserWork(): () => void;
  onUnauthorized(): void;
}

export function createApi(lifecycle: ApiLifecycle, fetcher: typeof fetch = (...args) => fetch(...args)) {
  const { observeServerVersion, beginBrowserWork, onUnauthorized } = lifecycle;
  const client = hc<AppType>("/", { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetcher(input, { ...init, cache: "no-store" }), headers: () => ({ "x-palmagent-version": lifecycle.version() }) }).api;
  const tasks = client.tasks[":id"];
  const routines = client.routines[":id"];
  // hc substitutes path parameters verbatim; preserve the previous URL encoding.
  const idParam = (id: string) => ({ id: encodeURIComponent(id) });
  type JsonResponse<T> = Pick<Response, "status" | "statusText" | "headers"> & (
    { ok: true; json(): Promise<T> } | { ok: false; json(): Promise<unknown> }
  );

  // Hono owns paths, query encoding, bodies, and response types. Keep the product's
  // auth/update lifecycle around the typed call, including response consumption.
  type AdmissionReceipt = { state: "accepted"; requestId?: string };
  async function request<T>(send: (signal?: AbortSignal) => Promise<JsonResponse<T>>, opts?: {
    write?: boolean; authProbe?: boolean; sessionChange?: boolean; invalidates?: readonly ClientReadScope[];
    messageScope?: string; onAccepted?(): void; images?: readonly InputAttachment[];
  }): Promise<Exclude<T, AdmissionReceipt>> {
    const finish = opts?.write ? beginBrowserWork() : undefined;
    // Invalidate on both sides: reads racing a write cannot refill the cache,
    // including when a failed response leaves the write outcome uncertain.
    // Keep a pending sign-out on its current screen. Retire the session only
    // when the auth write succeeds (or a 401 confirms it is already invalid).
    const generation = cacheSession();
    const load = async (signal?: AbortSignal) => {
      if (generation !== cacheSession()) throw new ApiError(401, "Session changed. Please try again.");
      const res = await send(signal);
      if (generation !== cacheSession()) throw new ApiError(401, "Session changed. Please try again.");
      observeServerVersion(res.headers.get("x-palmagent-version"));
      if (!res.ok) {
        if (res.status === 401) {
          invalidateClientReads(true);
          if (!opts?.authProbe) onUnauthorized();
        }
        const json: unknown = await res.json().catch(() => null);
        const message = json && typeof json === "object" && "error" in json && typeof json.error === "string" ? json.error : undefined;
        if (res.status === 413 && message === undefined) {
          throw new ApiError(413, "Request too large for the proxy — shrink/remove attachments (or raise nginx client_max_body_size).");
        }
        const code = json && typeof json === "object" && "code" in json && typeof json.code === "string" ? json.code : undefined;
        throw new ApiError(res.status, message ?? res.statusText, code);
      }
      if (opts?.messageScope && res.status === 202 && res.headers.get("preference-applied") === "respond-async") {
        await res.json();
        opts.onAccepted?.();
        throw new ApiError(202, "Received. Waiting for the update to finish…", "admission_pending");
      }
      const value = await res.json();
      if (generation !== cacheSession()) throw new ApiError(401, "Session changed. Please try again.");
      // Deferred receipts take the retry branch above.
      return value as Exclude<T, AdmissionReceipt>;
    };
    try {
      if (opts?.write && !opts.sessionChange) await invalidateClientReads(false, opts.invalidates);
      const value = opts?.messageScope ? await retryMessage(opts.messageScope, load, error => {
        if (error instanceof ApiError) {
          if (error.code === "admission_pending") return error.message;
          if (error.status === 503 && error.code === "update_in_progress") return "Waiting for update…";
          if (error.status === 502 || error.status === 504) return "Reconnecting to send…";
        }
        if (error instanceof TypeError || error instanceof DOMException && error.name === "TimeoutError") return "Reconnecting to send…";
        return undefined;
      }, opts.images) : await load();
      if (opts?.sessionChange) await invalidateClientReads(true);
      return value;
    } finally {
      try {
        if (opts?.write && !opts.sessionChange && generation === cacheSession()) await invalidateClientReads(false, opts.invalidates);
      } finally { finish?.(); }
    }
  }
  const read = <T>(send: () => Promise<JsonResponse<T>>, signal?: AbortSignal, authProbe = false) => {
    const generation = cacheSession();
    return recoverUpdateRead(() => {
      if (generation !== cacheSession()) throw new ApiError(401, "Session changed. Please try again.");
      return request(send, { authProbe });
    }, error => error instanceof ApiError && error.status === 503 && error.code === "update_in_progress", signal);
  };
  const write = <T>(send: () => Promise<JsonResponse<T>>, authProbe = false, sessionChange = false, invalidates: readonly ClientReadScope[] = []) =>
    request(send, { write: true, authProbe, sessionChange, invalidates });
  const attachmentOptions = (input: object) => {
    const upload = attachmentFetch(input, fetcher);
    return upload ? { fetch: upload } : {};
  };
  const requestOptions = (signal?: AbortSignal) => signal ? { init: { signal } } : undefined;

  const api = {
    sideChat: {
      get: (id: string) => read(() => tasks["side-chat"].$get({ param: idParam(id) })).then(r => r.sideChat),
      open: (id: string) => write(() => tasks["side-chat"].$post({ param: idParam(id), json: {} })).then(r => r.sideChat),
      send: (id: string, json: import("@palmagent/shared").SideChatSend) => write(() => tasks["side-chat"].messages.$post({ param: idParam(id), json })).then(r => r.sideChat),
      stop: (id: string, sessionId: string) => write(() => tasks["side-chat"].stop.$post({ param: idParam(id), json: { sessionId } })).then(r => r.sideChat),
      end: (id: string, sessionId: string) => write(() => tasks["side-chat"].$delete({ param: idParam(id), json: { sessionId } })).then(r => r.sideChat),
    },
    voice: {
      start: (json: import("@palmagent/shared").VoiceStart, signal: AbortSignal) => request(() => client.voice.$post({ json }, { init: { signal } })),
      heartbeat: (id: string) => request(() => client.voice[":id"].heartbeat.$post({ param: idParam(id) })),
      stop: (id: string, timings: import("@palmagent/shared").VoiceClientTimings) => request(() =>
        client.voice[":id"].$delete({ param: idParam(id), json: { timings } }, { init: { keepalive: true } })),
    },
    skills: (query: import("@palmagent/shared").SkillContext, signal?: AbortSignal) => read(() => client.skills.$get({ query }, requestOptions(signal)), signal),
    terminals: {
      list: (query: { taskId?: string; repoId?: string } = {}) => read(() => client.terminals.$get({ query })),
      create: (json: CreateTerminalRequest) => write(() => client.terminals.$post({ json })),
      rename: (id: string, title: string) => write(() => client.terminals[":id"].$patch({ param: idParam(id), json: { title } })),
      terminate: (id: string) => write(() => client.terminals[":id"].terminate.$post({ param: idParam(id) })),
      ticket: (id: string) => write(() => client.terminals[":id"]["attach-ticket"].$post({ param: idParam(id) })),
    },
    telemetry: {
      get: () => read(() => client.settings.telemetry.$get()),
      change: (enabled: boolean) => write(() => client.settings.telemetry.$patch({ json: { enabled, retentionDays: 180 } })),
    },
    repoSettings: {
      get: () => read(() => client.settings.repos.$get()),
      change: (json: RepoSettingsChange) => write(() => client.settings.repos.$patch({ json })),
    },
    submitMessage: (id: string, input: SubmitMessage) => {
      const json = snapshotRequest(input);
      let accepted = false;
      return request<MessageQueue | AdmissionReceipt>(signal => accepted
        ? tasks.messages[":messageId"].receipt.$get({ param: { ...idParam(id), messageId: json.clientMessageId } }, requestOptions(signal))
        : tasks.messages.$post({ param: idParam(id), json }, {
        headers: { [MESSAGE_PROTOCOL_HEADER]: MESSAGE_PROTOCOL_VERSION, prefer: "respond-async" }, init: { signal },
        ...attachmentOptions(json),
      }), { write: true, messageScope: id, images: json.images, onAccepted: () => { accepted = true; } });
    },
    messageAction: (id: string, messageId: string, json: MessageAction) => write(() => tasks.messages[":messageId"].$post({ param: { ...idParam(id), messageId: encodeURIComponent(messageId) }, json }, attachmentOptions(json))),
    resumeQueue: (id: string) => write(() => tasks.queue.resume.$post({ param: idParam(id), json: {} })),
    compact: (id: string, json: import("@palmagent/shared").CompactTaskRequest) => write(() => tasks.compact.$post({ param: idParam(id), json })).then(r => r.task),
    updateSettings: {
      action: (json: UpdateAction) => write(() => client.settings.updates.$post({ json })),
      get: () => read(() => client.settings.updates.$get()),
      change: (json: UpdateSettingsChange) => write(() => client.settings.updates.$patch({ json })),
    },
    listRepos: (signal?: AbortSignal) => read(() => client.repos.$get({}, requestOptions(signal)), signal).then((r) => r.repos),
    modelCatalog: (agent: AgentKind, taskId?: string, signal?: AbortSignal) => read(() => client["model-catalog"].$get({ query: taskId ? { taskId } : { agent } }, requestOptions(signal)), signal),
    createRepo: (json: CreateRepoRequest) => write(() => client.repos.$post({ json }), false, false, ["repos"]).then((r) => r.repo),
    updateRepo: (id: string, json: UpdateRepoRequest) => write(() => client.repos[":id"].$patch({ param: idParam(id), json }), false, false, ["repos"]).then(r => r.repo),
    deleteRepo: (id: string) => write(() => client.repos[":id"].$delete({ param: idParam(id) }), false, false, ["repos"]).then((r) => r.repo),
    discoverRepos: (refresh = false, signal?: AbortSignal) => read(() => client.repos.discover.$get({ query: refresh ? { refresh: "1" } : {} }, requestOptions(signal)), signal),
    validateRepoPath: (path: string, signal?: AbortSignal) => read(() => client.repos.validate.$get({ query: { path } }, requestOptions(signal)), signal),
    listFs: (path?: string, signal?: AbortSignal) => read(() => client.fs.list.$get({ query: { path } }, requestOptions(signal)), signal),
    taskFile: (id: string, path: string, signal: AbortSignal) => read(() => tasks.file.$get({ param: idParam(id), query: { path } }, requestOptions(signal)), signal),
    listTasks: (status?: TaskStatus) => read(() => client.tasks.$get({ query: { status } })).then((r) => r.tasks),
    taskHistory: (id: string, before?: number, details: "summary" | "full" = "full", signal?: AbortSignal, transcript = false) => read(() => tasks.history.$get({
      param: idParam(id), query: { ...(transcript ? { format: "transcript" as const } : {}), ...(before === undefined ? {} : { before: String(before) }), ...(details === "summary" ? { details } : {}) },
    }, { init: { signal } }), signal),
    taskHistoryChanges: (id: string, after: number, through: number, details: "summary" | "full" = "full", signal?: AbortSignal, transcript = false, afterKey?: number) => read(() => tasks.history.changes.$get({
      param: idParam(id), query: { ...(transcript ? { format: "transcript" as const } : {}), ...(afterKey === undefined ? {} : { afterKey: String(afterKey) }), after: String(after), through: String(through), ...(details === "summary" ? { details } : {}) },
    }, { init: { signal } }), signal),
    conversationSteps: (id: string, key: number, after?: number, signal?: AbortSignal) => read(() => tasks.history.steps.$get({
      param: idParam(id), query: { key: String(key), ...(after === undefined ? {} : { after: String(after) }) },
    }, { init: { signal } }), signal),
    conversationStepDetails: (id: string, key: number, step: number, after?: number, signal?: AbortSignal) => read(() => tasks.history["step-details"].$get({
      param: idParam(id), query: { key: String(key), step: String(step), ...(after === undefined ? {} : { after: String(after) }) },
    }, { init: { signal } }), signal),
    executionRecords: (id: string, before?: number, signal?: AbortSignal) => read(() => tasks.history.records.$get({
      param: idParam(id), query: { ...(before === undefined ? {} : { before: String(before) }) },
    }, { init: { signal } }), signal),
    executionRecordContent: (id: string, key: number, version: string, offset: number, signal?: AbortSignal) => read(() => tasks.history["record-content"].$get({
      param: idParam(id), query: { key: String(key), version, offset: String(offset) },
    }, { init: { signal } }), signal),
    conversationDetails: (id: string, key: number, after?: number, signal?: AbortSignal) => read(() => tasks.history.items.$get({
      param: idParam(id), query: { key: String(key), ...(after === undefined ? {} : { after: String(after) }) },
    }, { init: { signal } }), signal),
    conversationContent: (id: string, ref: import("@palmagent/shared").ConversationContentRef, offset: number, signal?: AbortSignal) => read(() => tasks.history.content.$get({
      param: idParam(id), query: { key: String(ref.key), version: ref.version, offset: String(offset), ...(ref.member === undefined ? {} : { member: String(ref.member) }) },
    }, { init: { signal } }), signal),
    taskActivityDetails: (id: string, from: number, through: number, signal?: AbortSignal) => read(() => tasks.history.details.$get({
      param: idParam(id), query: { from: String(from), through: String(through) },
    }, { init: { signal } }), signal),
    getTask: (id: string) => read(() => tasks.$get({ param: idParam(id) })).then((r) => r.task),
    getAccountLimits: (id: string) => read(() => tasks["account-limits"].$get({ param: idParam(id) })),
    createTask: (input: CreateTaskRequest) => {
      const json = snapshotRequest(input);
      // Legacy callers without an idempotency key must never be replayed.
      let attempted = false, accepted = false;
      return (json.clientRequestId ? request<{ task: TaskState } | AdmissionReceipt>(async signal => {
        if (accepted) return client.tasks["creation-receipts"][":id"].$get({ param: idParam(json.clientRequestId!) }, requestOptions(signal));
        if (attempted) {
          const found = await tasks.$get({ param: idParam(`t_${json.clientRequestId}`) }, requestOptions(signal));
          if (found.status !== 404) return found;
        }
        signal?.throwIfAborted();
        attempted = true;
        return client.tasks.$post({ json }, {
          headers: { [MESSAGE_PROTOCOL_HEADER]: MESSAGE_PROTOCOL_VERSION, prefer: "respond-async" }, init: { signal },
          ...attachmentOptions(json),
        });
      }, { write: true, messageScope: "dispatch", images: json.images, onAccepted: () => { accepted = true; } }) : write<{ task: TaskState } | AdmissionReceipt>(() => client.tasks.$post({ json }, attachmentOptions(json)))).then(r => r.task);
    },
    moveTaskPin: (id: string, targetId: string, placement: "before" | "after") => write(() => tasks["pin-position"].$patch({ param: idParam(id), json: { targetId, placement } })).then((r) => r.tasks),
    pinTask: (id: string, pinned: boolean) => write(() => tasks.pin.$patch({ param: idParam(id), json: { pinned } })).then((r) => r.task),
    renameTask: (id: string, json: RenameTaskRequest) => write(() => tasks.$patch({ param: idParam(id), json })).then((r) => r.task),
    agentInstallations: (signal?: AbortSignal) => read(() => client.agents.$get({}, requestOptions(signal)), signal),
    agentLimits: (agent: AgentKind, signal?: AbortSignal) => read(() => client.agents[":agent"].limits.$get({ param: { agent } }, requestOptions(signal)), signal),
    updateAgent: (agent: AgentKind, expectedVersion: string) => write(() => client.agents[":agent"].update.$post({ param: { agent }, json: { expectedVersion } }), false, false, ["agents", "modelCatalog"]),
    getUsage: (signal?: AbortSignal) => read(() => client.usage.$get({}, requestOptions(signal)), signal).then((r) => r.usage),
    followup: (id: string, json: FollowupRequest) => write(() => tasks.followup.$post({ param: idParam(id), json }, attachmentOptions(json))).then((r) => r.task),
    steer: (id: string, json: SteerRequest) => write(() => tasks.steer.$post({ param: idParam(id), json }, attachmentOptions(json))),
    approve: (id: string, json: ApproveRequest) => write(() => tasks.approve.$post({ param: idParam(id), json })).then((r) => r.task),
    answer: (id: string, json: AnswerRequest) => write(() => tasks.answer.$post({ param: idParam(id), json }, { headers: { [TURN_CONTROL_HEADER]: TURN_CONTROL_VERSION } })).then((r) => r.task),
    handoff: (id: string) => write(() => tasks.handoff.$post({ param: idParam(id) })),
    stop: (id: string, expectedRunId?: string | null) => write(() => tasks.stop.$post({ param: idParam(id), json: { expectedRunId } },
      expectedRunId === undefined ? {} : { headers: { [TURN_CONTROL_HEADER]: TURN_CONTROL_VERSION } })).then((r) => r.task),
    cancel: (id: string) => write(() => tasks.cancel.$post({ param: idParam(id), json: {} })).then((r) => r.task),
    archive: (id: string) => write(() => tasks.$delete({ param: idParam(id) })).then((r) => r.task),
    listRoutines: (signal?: AbortSignal) => read(() => client.routines.$get({}, requestOptions(signal)), signal).then((r) => r.routines),
    createRoutine: (json: CreateRoutineRequest) => write(() => client.routines.$post({ json }), false, false, ["routines", "routineRuns"]).then((r) => r.routine),
    updateRoutine: (id: string, json: UpdateRoutineRequest) => write(() => routines.$patch({ param: idParam(id), json }), false, false, ["routines", "routineRuns"]).then((r) => r.routine),
    deleteRoutine: (id: string) => write(() => routines.$delete({ param: idParam(id) }), false, false, ["routines", "routineRuns"]).then((r) => r.routine),
    runRoutine: (id: string) => write(() => routines.run.$post({ param: idParam(id) }), false, false, ["routines", "routineRuns"]).then((r) => r.routine),
    stopRoutine: (id: string) => write(() => routines.stop.$post({ param: idParam(id) }), false, false, ["routines", "routineRuns"]).then(r => r.routine),
    routineRuns: (id: string, signal?: AbortSignal) => read(() => routines.runs.$get({ param: idParam(id) }, requestOptions(signal)), signal).then((r) => r.runs),
    auth: {
      me: () => read(() => client.auth.me.$get(), undefined, true),
      githubStart: (json: { setupKey?: string; returnHash?: string }) => write(() => client.auth.github.start.$post({ json }), true),
      loginOptions: () => write(() => client.auth.login.options.$post(), true),
      loginVerify: (json: AuthenticationResponseJSON) => write(() => client.auth.login.verify.$post({ json: { ...json, clientExtensionResults: { ...json.clientExtensionResults } } }), true, true),
      registerOptions: (token?: string) => write(() => client.auth.register.options.$post({ json: { token } }), true),
      registerVerify: (response: RegistrationResponseJSON, label?: string) => write(() => client.auth.register.verify.$post({ json: { response: { ...response, clientExtensionResults: { ...response.clientExtensionResults } }, label } }), true, true),
      logout: () => write(() => client.auth.logout.$post(), true, true),
      reauthenticateOptions: (action: import("@palmagent/shared").AuthAction) => write(() => client.auth.reauthenticate.options.$post({ json: { action } })),
      reauthenticateVerify: (json: AuthenticationResponseJSON) => write(() => client.auth.reauthenticate.verify.$post({ json: { ...json, clientExtensionResults: { ...json.clientExtensionResults } } })),
      enrollToken: (authorization: string) => write(() => client.auth["enroll-token"].$post({ json: { authorization } })),
      passkeys: () => read(() => client.auth.passkeys.$get()).then(result => result.passkeys),
      removePasskey: (authorization: string, credentialId: string) => write(() => client.auth.passkeys.remove.$post({ json: { authorization, credentialId } }), false, true),
      logoutAll: (authorization: string) => write(() => client.auth["logout-all"].$post({ json: { authorization } }), false, true),
    },
    push: {
      key: () => read(() => client.push.key.$get()),
      subscribe: (subscription: PushSubscribeRequest["subscription"]) => write(() => client.push.subscribe.$post({ json: { subscription } })),
      unsubscribe: (endpoint: string) => write(() => client.push.unsubscribe.$post({ json: { endpoint } })),
    },
  };

  return api;
}
