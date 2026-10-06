import { createServer, request } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { createSessionApp } from "./local-app.js";
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DispatchSessionRequest } from "@palmagent/shared";
import type { TaskService } from "../modules/tasks/application/use-cases/task-service.js";
import { ensurePrivateParent } from "../platform/filesystem/private-files.js";

import { sessionSocket } from "../modules/tasks/adapters/inbound/session-control.js";

// This Unix socket is a host-owner capability, separate from browser passkeys.
// Exposes local-session dispatch and terminal management to the installation owner.
export async function startSessionControl(dataDir: string, service: TaskService, terminals?: import("../modules/terminals/application/use-cases/terminal-service.js").TerminalService, routines?: import("../modules/routines/application/use-cases/routine-service.js").RoutineService) {
  ensurePrivateParent(dataDir);
  const socket = sessionSocket(dataDir);
  try {
    const stat = lstatSync(socket);
    if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error("Unsafe session control socket path");
    // Probe before removing a socket left behind by a crashed server.
    const { createConnection } = await import("node:net");
    await new Promise<void>((resolve, reject) => {
      const probe = createConnection(socket);
      probe.setTimeout(3000, () => { probe.destroy(); reject(new Error("Session control socket probe timed out")); });
      probe.once("connect", () => { probe.destroy(); reject(new Error("Session control is already running")); });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(); else reject(error);
      });
    });
    try { unlinkSync(socket); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const app = createSessionApp(service, terminals, routines);
  const server = createServer({ requestTimeout: 10_000 }, getRequestListener(app.fetch));
  const oldMask = process.umask(0o077);
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, () => { chmodSync(socket, 0o600); resolve(); }); });
  } finally { process.umask(oldMask); }
  const timer = setInterval(() => service.reconcileLocalSessions(), 1000);
  timer.unref();
  server.once("close", () => clearInterval(timer));
  return server;
}
