import type { AuthService } from "../auth.js";
import type { CodexModelCatalogReader } from "../model-catalog.js";
import type { PushService } from "../push.js";
import type { RoutineService } from "../routines.js";
import type { TaskService } from "../service.js";
import type { SettingsStore } from "../settings.js";
import type { UpdateSettingsService } from "../update-settings.js";
import type { TerminalService } from "../terminal/service.js";
import type { TerminalTickets } from "../terminal/gateway.js";
import type { LiveEventStream } from "../application/ports.js";

/** HTTP adapters see only the use cases each route needs, never their implementations or persistence. */
export type HttpTaskUseCases = Pick<TaskService,
  | "updating" | "executionProtocol" | "usage" | "availableSkills" | "listTasks" | "getTask" | "accountLimits"
  | "createTask" | "resolveSkills" | "readAttachment" | "readTaskImage" | "rename" | "taskActivityDetails"
  | "taskHistoryChanges" | "taskHistory" | "archive" | "handoff" | "resolveMessageSkills" | "submitMessage"
  | "messageAction" | "resumeQueue" | "followup" | "steer" | "approve" | "answer" | "stop" | "cancel"
  | "listRepos" | "createRepo" | "deleteRepo" | "startVoice" | "touchVoice" | "stopVoice" | "eventCursor" | "providerHome"
>;

export type HttpDependencies = {
  terminals?: Pick<TerminalService, "list" | "capabilities" | "create" | "getPublic" | "rename" | "terminate">;
  terminalTickets?: Pick<TerminalTickets, "issue">;
  settings: Pick<SettingsStore, "get" | "change">;
  hub: LiveEventStream;
  service: HttpTaskUseCases;
  auth: Pick<AuthService,
    | "enabled" | "origin" | "verifySession" | "sessionValid" | "status" | "beginAuthentication"
    | "finishAuthentication" | "beginRegistration" | "finishRegistration" | "logout" | "mintEnrollToken"
  >;
  push: Pick<PushService, "getPublicKey" | "subscribe" | "unsubscribe">;
  routines: Pick<RoutineService, "list" | "create" | "get" | "update" | "remove" | "runNow" | "stopRun" | "runs">;
  modelCatalog: Pick<CodexModelCatalogReader, "get">;
  config: { repoRoots: string[]; keepAliveMs: number; staticDir: string; cookieName: string };
  build?: { version: string; sourceCommit: string; dirty: boolean };
  shutdown?: AbortSignal;
  updates?: Pick<UpdateSettingsService, "status" | "change" | "action">;
};
