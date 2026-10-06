import type { AuthUseCases } from "../modules/auth/api.js";
import type { AgentInstallations } from "../modules/agents/api.js";
import type { ModelCatalog } from "../modules/agents/api.js";
import type { PushUseCases } from "../modules/tasks/api.js";
import type { RoutineUseCases } from "../modules/routines/api.js";
import type { TaskUseCases } from "../modules/tasks/api.js";
import type { SpaceSettings } from "../modules/spaces/api.js";
import type { UpdateUseCases } from "../modules/installation/api.js";
import type { TerminalUseCases } from "../modules/terminals/api.js";
import type { TerminalTickets } from "../modules/terminals/adapters/inbound/gateway.js";
import type { LiveEventStream } from "../kernel/events.js";

/** HTTP adapters see only the use cases each route needs, never their implementations or persistence. */
export type HttpTaskUseCases = TaskUseCases;

export type HttpDependencies = {
  agentInstallations?: Pick<AgentInstallations, "list" | "update">;
  terminals?: Pick<TerminalUseCases, "list" | "capabilities" | "create" | "getPublic" | "rename" | "terminate">;
  terminalTickets?: Pick<TerminalTickets, "issue">;
  settings: Pick<SpaceSettings, "get" | "change">;
  hub: LiveEventStream;
  service: HttpTaskUseCases & import("../modules/spaces/api.js").SpaceUseCases;
  auth: Pick<AuthUseCases,
    | "enabled" | "origin" | "verifySession" | "sessionValid" | "status" | "beginAuthentication"
    | "finishAuthentication" | "beginRegistration" | "finishRegistration" | "logout" | "mintEnrollToken"
  >;
  push: Pick<PushUseCases, "getPublicKey" | "subscribe" | "unsubscribe">;
  routines: Pick<RoutineUseCases, "list" | "create" | "get" | "update" | "remove" | "runNow" | "stopRun" | "runs" | "context" | "start" | "stop">;
  modelCatalog: Pick<ModelCatalog, "get">;
  config: { repoRoots: string[]; keepAliveMs: number; staticDir: string; cookieName: string };
  build?: { version: string; sourceCommit: string; dirty: boolean };
  shutdown?: AbortSignal;
  updates?: Pick<UpdateUseCases, "status" | "change" | "action">;
};
