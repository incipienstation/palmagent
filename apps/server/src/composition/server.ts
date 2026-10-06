import { ResourceScope } from "../kernel/resource-scope.js";
import { installTerminalGateway } from "../modules/terminals/adapters/inbound/gateway.js";
import { terminalPlatform } from "../modules/terminals/adapters/outbound/terminal-platform.js";
import { bindUpdateActivity } from "../modules/installation/adapters/outbound/update-activity.js";
import { watch } from "node:fs";
import { readUpdateAccess, updateAccessFile } from "../modules/installation/adapters/outbound/update-access.js";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { BRANDING } from "@palmagent/shared";
import { createApp } from "./http-app.js";
import { createRuntime } from "./server-runtime.js";
import { startSessionControl } from "./session-control.js";
import { createUpdateSettingsService } from "../modules/installation/adapters/outbound/cli-update-settings.js";
import { createSpaceSettings } from "../modules/spaces/composition.js";
import { createAgentInstallationService } from "../modules/agents/composition.js";
import { acquireUpdateLock, UpdateBusyError } from "../platform/filesystem/update-lock.js";
import { userConfigPath } from "../modules/installation/adapters/outbound/user-config.js";
import { ApplicationError } from "../kernel/errors.js";

function closeServer(listener: Server): Promise<void> {
  if (!listener.listening) return Promise.resolve();
  return new Promise((resolve) => {
    const deadline = setTimeout(() => listener.closeAllConnections(), 3000);
    listener.close(() => { clearTimeout(deadline); resolve(); });
  });
}
export async function startServer(options: { build?: { version: string; sourceCommit: string; dirty: boolean }; packageDir?: string }) {
const { build } = options;
const resources = new ResourceScope();
try {
  const runtime = await createRuntime();
  resources.defer(() => runtime.close());
  const shutdown = new AbortController();
  resources.onStop(() => shutdown.abort());
  const updates = createUpdateSettingsService({
    packageDir: options.packageDir,
    dataDir: runtime.config.dataDir, dbPath: runtime.config.dbPath,
  });
  const updateActivity = bindUpdateActivity(runtime.hub,
    () => Boolean(build && readUpdateAccess(runtime.config.dataDir).pending), () => updates.resume());
  resources.defer(() => updateActivity.close());
  // Native file events deliver results from the independent updater. No status timer.
  const updateWatcher = build ? watch(runtime.config.dataDir, (_event, filename) => {
    if (filename === updateAccessFile || filename === "update-result.json") runtime.hub.emitUpdates();
  }) : undefined;
  resources.defer(() => updateWatcher?.close());
  updateWatcher?.on("error", () => { updateWatcher.close(); });
  const settings = createSpaceSettings(runtime.config.dataDir, runtime.config.repoRoots);
  const agentInstallations = createAgentInstallationService(agent => runtime.service.providerHome(agent), {
    lock: () => {
      try { return acquireUpdateLock(dirname(userConfigPath())); }
      catch (error) { throw new ApplicationError(error instanceof UpdateBusyError ? "conflict" : "service_unavailable", "Another host operation is running, or the update lock is unavailable. Try again after it finishes."); }
    },
  }, runtime.config.dataDir);
  resources.defer(() => agentInstallations.close());
  const app = createApp({ ...runtime, settings, build, updates, agentInstallations, shutdown: shutdown.signal });
  const server = createServer(getRequestListener(app.fetch));
  resources.defer(() => closeServer(server));
  const closeTerminals = installTerminalGateway(server, { service: runtime.terminals, auth: runtime.auth, tickets: runtime.terminalTickets,
    transport: terminalPlatform(true).transport, origin: runtime.config.authOrigin, cookieName: runtime.config.cookieName });

  resources.onStop(closeTerminals);
  const local = await startSessionControl(dirname(runtime.config.dbPath), runtime.service, runtime.terminals, runtime.routines);
  resources.defer(() => closeServer(local));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(runtime.config.port, runtime.config.host, () => { server.off("error", reject); resolve(); });
  });
  runtime.start();
  void updateActivity.wake();
  console.log(`${BRANDING.productName} internal listener on ${runtime.config.host}:${runtime.config.port}  ·  TLS required at the public edge  ·  db=${runtime.config.dbPath}  ·  cap=${runtime.config.concurrency}`);
  return { close: () => resources.close() };
} catch (error) { return resources.fail(error); }
}
