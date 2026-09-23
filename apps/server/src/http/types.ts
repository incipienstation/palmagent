import type { AuthService } from "../auth.js";
import type { config } from "../config.js";
import type { Db } from "../db.js";
import type { Hub } from "../hub.js";
import type { PushService } from "../push.js";
import type { RoutineService } from "../routines.js";
import type { TaskService } from "../service.js";
import type { UpdateSettingsService } from "../update-settings.js";
import type { SettingsStore } from "../settings.js";
import type { CodexModelCatalogReader } from "../model-catalog.js";

export interface HttpDependencies {
  terminals?: import("../terminal/service.js").TerminalService;
  terminalTickets?: import("../terminal/gateway.js").TerminalTickets;
  settings: SettingsStore;
  db: Db;
  hub: Hub;
  service: TaskService;
  auth: AuthService;
  push: PushService;
  routines: RoutineService;
  modelCatalog: CodexModelCatalogReader;
  config: Pick<typeof config, "repoRoots" | "keepAliveMs" | "staticDir" | "cookieName">;
  build?: { version: string; sourceCommit: string; dirty: boolean };
  shutdown?: AbortSignal;
  updates?: UpdateSettingsService;
}
