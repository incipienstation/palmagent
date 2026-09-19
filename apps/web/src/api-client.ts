import { cacheSession, invalidateClientReads, readCache } from "./read-cache";
import { hc } from "hono/client";
import type { Api } from "@palmagent/shared/http";
import type {
  AnswerRequest, ApproveRequest, CreateRepoRequest, CreateRoutineRequest,
  CreateTaskRequest, FollowupRequest, MessageAction, PushSubscribeRequest,
  RenameTaskRequest, RepoSettingsChange, SteerRequest, SubmitMessage, TaskStatus,
  UpdateAction, UpdateRoutineRequest, UpdateSettingsChange,
} from "@palmagent/shared";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/browser";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
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
  const client = hc<Api>("/", { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetcher(input, { ...init, cache: "no-store" }), headers: () => ({ "x-palmagent-version": lifecycle.version() }) }).api;
  const tasks = client.tasks[":id"];
  const routines = client.routines[":id"];
  // hc substitutes path parameters verbatim; preserve the previous URL encoding.
  const idParam = (id: string) => ({ id: encodeURIComponent(id) });
  type JsonResponse<T> = Pick<Response, "ok" | "status" | "statusText" | "headers"> & { json(): Promise<T> };

  // Hono owns paths, query encoding, bodies, and response types. Keep the product's
  // auth/update lifecycle around the typed call, including response consumption.
  async function request<T>(send: () => Promise<JsonResponse<T>>, opts?: {
    write?: boolean; authProbe?: boolean; sessionChange?: boolean; cacheKey?: string; ttl?: number;
  }): Promise<T> {
    const finish = opts?.write ? beginBrowserWork() : undefined;
    // Invalidate on both sides: reads racing a write cannot refill the cache,
    // including when a failed response leaves the write outcome uncertain.
    if (opts?.write) invalidateClientReads(opts.sessionChange);
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
        throw new ApiError(res.status, message ?? res.statusText);
      }
      const value = await res.json();
      if (generation !== cacheSession()) throw new ApiError(401, "Session changed. Please try again.");
      return value;
    };
    try {
      return await (opts?.cacheKey ? readCache.read(opts.cacheKey, opts.ttl!, load) : load());
    } finally {
      if (opts?.write) invalidateClientReads(opts.sessionChange);
      finish?.();
    }
  }
  const write = <T>(send: () => Promise<JsonResponse<T>>, authProbe = false, sessionChange = false) => request(send, { write: true, authProbe, sessionChange });
  // Only these catalog/summary reads opt in. Auth, live task state, settings,
  // discovery, filesystem validation, history pages and quotas use the network.
  const cached = <T>(key: string, ttl: number, send: () => Promise<JsonResponse<T>>) => request(send, { cacheKey: key, ttl });

  const api = {
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
    listRepos: (refresh = false) => {
      if (refresh) readCache.invalidate(key => key === "/api/repos");
      return cached("/api/repos", 30_000, () => client.repos.$get()).then((r) => r.repos);
    },
    createRepo: (json: CreateRepoRequest) => write(() => client.repos.$post({ json })).then((r) => r.repo),
    deleteRepo: (id: string) => write(() => client.repos[":id"].$delete({ param: idParam(id) })).then((r) => r.repo),
    discoverRepos: (refresh = false) => request(() => client.repos.discover.$get({ query: refresh ? { refresh: "1" } : {} })),
    validateRepoPath: (path: string) => request(() => client.repos.validate.$get({ query: { path } })),
    listFs: (path?: string) => request(() => client.fs.list.$get({ query: { path } })),
    listTasks: (status?: TaskStatus) => request(() => client.tasks.$get({ query: { status } })).then((r) => r.tasks),
    taskHistory: (id: string, before: number, signal?: AbortSignal) => request(() => tasks.history.$get({ param: idParam(id), query: { before: String(before) } }, { init: { signal } })),
    getTask: (id: string) => request(() => tasks.$get({ param: idParam(id) })).then((r) => r.task),
    getAccountLimits: (id: string) => request(() => tasks["account-limits"].$get({ param: idParam(id) })),
    createTask: (json: CreateTaskRequest) => write(() => client.tasks.$post({ json })).then((r) => r.task),
    renameTask: (id: string, json: RenameTaskRequest) => write(() => tasks.$patch({ param: idParam(id), json })).then((r) => r.task),
    getUsage: () => cached("/api/usage", 10_000, () => client.usage.$get()).then((r) => r.usage),
    followup: (id: string, json: FollowupRequest) => write(() => tasks.followup.$post({ param: idParam(id), json })).then((r) => r.task),
    steer: (id: string, json: SteerRequest) => write(() => tasks.steer.$post({ param: idParam(id), json })),
    approve: (id: string, json: ApproveRequest) => write(() => tasks.approve.$post({ param: idParam(id), json })).then((r) => r.task),
    answer: (id: string, json: AnswerRequest) => write(() => tasks.answer.$post({ param: idParam(id), json })).then((r) => r.task),
    handoff: (id: string) => write(() => tasks.handoff.$post({ param: idParam(id) })),
    stop: (id: string) => write(() => tasks.stop.$post({ param: idParam(id), json: {} })).then((r) => r.task),
    cancel: (id: string) => write(() => tasks.cancel.$post({ param: idParam(id), json: {} })).then((r) => r.task),
    archive: (id: string) => write(() => tasks.$delete({ param: idParam(id) })).then((r) => r.task),
    listRoutines: () => cached("/api/routines", 30_000, () => client.routines.$get()).then((r) => r.routines),
    createRoutine: (json: CreateRoutineRequest) => write(() => client.routines.$post({ json })).then((r) => r.routine),
    updateRoutine: (id: string, json: UpdateRoutineRequest) => write(() => routines.$patch({ param: idParam(id), json })).then((r) => r.routine),
    deleteRoutine: (id: string) => write(() => routines.$delete({ param: idParam(id) })).then((r) => r.routine),
    runRoutine: (id: string) => write(() => routines.run.$post({ param: idParam(id) })).then((r) => r.routine),
    routineRuns: (id: string) => cached(`/api/routines/${encodeURIComponent(id)}/runs`, 10_000, () => routines.runs.$get({ param: idParam(id) })).then((r) => r.runs),
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
