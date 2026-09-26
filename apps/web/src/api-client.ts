import type { CreateTerminalRequest } from "@palmagent/shared/terminals";
import { cacheSession, invalidateClientReads, type ClientReadScope } from "./query-lifecycle";
import { hc } from "hono/client";
import type { AppType } from "@palmagent/server/http-api";
import type { ApiErrorResponse } from "@palmagent/shared/http";
import type {
  AnswerRequest, ApproveRequest, CreateRepoRequest, CreateRoutineRequest,
  CreateTaskRequest, FollowupRequest, MessageAction, PushSubscribeRequest,
  RenameTaskRequest, RepoSettingsChange, SteerRequest, SubmitMessage, TaskStatus,
  UpdateAction, UpdateRoutineRequest, UpdateSettingsChange,
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
  async function request<T>(send: () => Promise<JsonResponse<T>>, opts?: {
    write?: boolean; authProbe?: boolean; sessionChange?: boolean; invalidates?: readonly ClientReadScope[];
  }): Promise<T> {
    const finish = opts?.write ? beginBrowserWork() : undefined;
    // Invalidate on both sides: reads racing a write cannot refill the cache,
    // including when a failed response leaves the write outcome uncertain.
    if (opts?.write) await invalidateClientReads(opts.sessionChange, opts.invalidates);
    const generation = cacheSession();
    const load = async () => {
      const res = await send();
      observeServerVersion(res.headers.get("x-palmagent-version"));
      if (!res.ok) {
        if (res.status === 401) {
          invalidateClientReads(true);
          if (!opts?.authProbe) onUnauthorized();
        }
        const json: unknown = await res.json().catch(() => null);
        const message = json && typeof json === "object" && "error" in json && typeof json.error === "string" ? json.error : undefined;
        if (res.status === 413 && message === undefined) {
          throw new ApiError(413, "Request too large for the proxy — shrink/remove images (or raise nginx client_max_body_size).");
        }
        const code = json && typeof json === "object" && "code" in json && typeof json.code === "string" ? json.code : undefined;
        throw new ApiError(res.status, message ?? res.statusText, code);
      }
      const value = await res.json();
      if (generation !== cacheSession()) throw new ApiError(401, "Session changed. Please try again.");
      return value;
    };
    try {
      return await load();
    } finally {
      if (opts?.write) await invalidateClientReads(opts.sessionChange, opts.invalidates);
      finish?.();
    }
  }
  const write = <T>(send: () => Promise<JsonResponse<T>>, authProbe = false, sessionChange = false, invalidates: readonly ClientReadScope[] = []) =>
    request(send, { write: true, authProbe, sessionChange, invalidates });
  const requestOptions = (signal?: AbortSignal) => signal ? { init: { signal } } : undefined;

  const api = {
    voice: {
      start: (json: import("@palmagent/shared").VoiceStart, signal: AbortSignal) => request(() => client.voice.$post({ json }, { init: { signal } })),
      heartbeat: (id: string) => request(() => client.voice[":id"].heartbeat.$post({ param: idParam(id) })),
      stop: (id: string, timings: import("@palmagent/shared").VoiceClientTimings) => request(() =>
        client.voice[":id"].$delete({ param: idParam(id), json: { timings } }, { init: { keepalive: true } })),
    },
    skills: (query: import("@palmagent/shared").SkillContext, signal?: AbortSignal) => request(() => client.skills.$get({ query }, requestOptions(signal))),
    terminals: {
      list: (query: { taskId?: string; repoId?: string } = {}) => request(() => client.terminals.$get({ query })),
      create: (json: CreateTerminalRequest) => write(() => client.terminals.$post({ json })),
      rename: (id: string, title: string) => write(() => client.terminals[":id"].$patch({ param: idParam(id), json: { title } })),
      terminate: (id: string) => write(() => client.terminals[":id"].terminate.$post({ param: idParam(id) })),
      ticket: (id: string) => write(() => client.terminals[":id"]["attach-ticket"].$post({ param: idParam(id) })),
    },
    repoSettings: {
      get: () => request(() => client.settings.repos.$get()),
      change: (json: RepoSettingsChange) => write(() => client.settings.repos.$patch({ json })),
    },
    submitMessage: (id: string, json: SubmitMessage) => write(() => tasks.messages.$post({ param: idParam(id), json })),
    messageAction: (id: string, messageId: string, json: MessageAction) => write(() => tasks.messages[":messageId"].$post({ param: { ...idParam(id), messageId: encodeURIComponent(messageId) }, json })),
    resumeQueue: (id: string) => write(() => tasks.queue.resume.$post({ param: idParam(id), json: {} })),
    updateSettings: {
      action: (json: UpdateAction) => write(() => client.settings.updates.$post({ json })),
      get: () => request(() => client.settings.updates.$get()),
      change: (json: UpdateSettingsChange) => write(() => client.settings.updates.$patch({ json })),
    },
    listRepos: (signal?: AbortSignal) => request(() => client.repos.$get({}, requestOptions(signal))).then((r) => r.repos),
    modelCatalog: (signal?: AbortSignal) => request(() => client["model-catalog"].$get({}, requestOptions(signal))),
    createRepo: (json: CreateRepoRequest) => write(() => client.repos.$post({ json }), false, false, ["repos"]).then((r) => r.repo),
    deleteRepo: (id: string) => write(() => client.repos[":id"].$delete({ param: idParam(id) }), false, false, ["repos"]).then((r) => r.repo),
    discoverRepos: (refresh = false) => request(() => client.repos.discover.$get({ query: refresh ? { refresh: "1" } : {} })),
    validateRepoPath: (path: string) => request(() => client.repos.validate.$get({ query: { path } })),
    listFs: (path?: string) => request(() => client.fs.list.$get({ query: { path } })),
    listTasks: (status?: TaskStatus) => request(() => client.tasks.$get({ query: { status } })).then((r) => r.tasks),
    taskHistory: (id: string, before?: number, details: "summary" | "full" = "full", signal?: AbortSignal) => request(() => tasks.history.$get({
      param: idParam(id), query: { ...(before === undefined ? {} : { before: String(before) }), ...(details === "summary" ? { details } : {}) },
    }, { init: { signal } })),
    taskHistoryChanges: (id: string, after: number, through: number, details: "summary" | "full" = "full", signal?: AbortSignal) => request(() => tasks.history.changes.$get({
      param: idParam(id), query: { after: String(after), through: String(through), ...(details === "summary" ? { details } : {}) },
    }, { init: { signal } })),
    taskActivityDetails: (id: string, from: number, through: number, signal?: AbortSignal) => request(() => tasks.history.details.$get({
      param: idParam(id), query: { from: String(from), through: String(through) },
    }, { init: { signal } })),
    getTask: (id: string) => request(() => tasks.$get({ param: idParam(id) })).then((r) => r.task),
    getAccountLimits: (id: string) => request(() => tasks["account-limits"].$get({ param: idParam(id) })),
    createTask: (json: CreateTaskRequest) => write(() => client.tasks.$post({ json })).then((r) => r.task),
    renameTask: (id: string, json: RenameTaskRequest) => write(() => tasks.$patch({ param: idParam(id), json })).then((r) => r.task),
    getUsage: (signal?: AbortSignal) => request(() => client.usage.$get({}, requestOptions(signal))).then((r) => r.usage),
    followup: (id: string, json: FollowupRequest) => write(() => tasks.followup.$post({ param: idParam(id), json })).then((r) => r.task),
    steer: (id: string, json: SteerRequest) => write(() => tasks.steer.$post({ param: idParam(id), json })),
    approve: (id: string, json: ApproveRequest) => write(() => tasks.approve.$post({ param: idParam(id), json })).then((r) => r.task),
    answer: (id: string, json: AnswerRequest) => write(() => tasks.answer.$post({ param: idParam(id), json })).then((r) => r.task),
    handoff: (id: string) => write(() => tasks.handoff.$post({ param: idParam(id) })),
    stop: (id: string) => write(() => tasks.stop.$post({ param: idParam(id), json: {} })).then((r) => r.task),
    cancel: (id: string) => write(() => tasks.cancel.$post({ param: idParam(id), json: {} })).then((r) => r.task),
    archive: (id: string) => write(() => tasks.$delete({ param: idParam(id) })).then((r) => r.task),
    listRoutines: (signal?: AbortSignal) => request(() => client.routines.$get({}, requestOptions(signal))).then((r) => r.routines),
    createRoutine: (json: CreateRoutineRequest) => write(() => client.routines.$post({ json }), false, false, ["routines", "routineRuns"]).then((r) => r.routine),
    updateRoutine: (id: string, json: UpdateRoutineRequest) => write(() => routines.$patch({ param: idParam(id), json }), false, false, ["routines", "routineRuns"]).then((r) => r.routine),
    deleteRoutine: (id: string) => write(() => routines.$delete({ param: idParam(id) }), false, false, ["routines", "routineRuns"]).then((r) => r.routine),
    runRoutine: (id: string) => write(() => routines.run.$post({ param: idParam(id) }), false, false, ["routines", "routineRuns"]).then((r) => r.routine),
    stopRoutine: (id: string) => write(() => routines.stop.$post({ param: idParam(id) }), false, false, ["routines", "routineRuns"]).then(r => r.routine),
    routineRuns: (id: string, signal?: AbortSignal) => request(() => routines.runs.$get({ param: idParam(id) }, requestOptions(signal))).then((r) => r.runs),
    auth: {
      me: () => request(() => client.auth.me.$get(), { authProbe: true }),
      loginOptions: () => write(() => client.auth.login.options.$post(), true),
      loginVerify: (json: AuthenticationResponseJSON) => write(() => client.auth.login.verify.$post({ json: { ...json, clientExtensionResults: { ...json.clientExtensionResults } } }), true, true),
      registerOptions: (token?: string) => write(() => client.auth.register.options.$post({ json: { token } }), true),
      registerVerify: (response: RegistrationResponseJSON, label?: string) => write(() => client.auth.register.verify.$post({ json: { response: { ...response, clientExtensionResults: { ...response.clientExtensionResults } }, label } }), true, true),
      logout: () => write(() => client.auth.logout.$post(), true, true),
      enrollToken: () => write(() => client.auth["enroll-token"].$post()),
    },
    push: {
      key: () => request(() => client.push.key.$get()),
      subscribe: (subscription: PushSubscribeRequest["subscription"]) => write(() => client.push.subscribe.$post({ json: { subscription } })),
      unsubscribe: (endpoint: string) => write(() => client.push.unsubscribe.$post({ json: { endpoint } })),
    },
  };

  return api;
}
