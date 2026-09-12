import { createServer, request } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { createSessionApp } from "./local/app.js";
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DispatchSessionRequest } from "@palmagent/shared";
import type { TaskService } from "./service.js";
import { ensurePrivateParent } from "./private-files.js";

export const sessionSocket = (dataDir: string) => join(dataDir, "session-control.sock");
export function localSessionRequest(dataDir: string, body: DispatchSessionRequest): Promise<{ task: { taskId: string } }> {
  return new Promise((resolve, reject) => {
    const stat = lstatSync(sessionSocket(dataDir));
    if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("Session control socket must be private and owned by this account");
    const req = request({ socketPath: sessionSocket(dataDir), path: "/dispatch", method: "POST", headers: { "content-type": "application/json" }, timeout: 10_000 }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; if (text.length > 1_000_000) req.destroy(new Error("Control response too large")); });
      res.on("end", () => {
        try { const value = JSON.parse(text); if (res.statusCode !== 200) reject(new Error(value.error ?? "Session dispatch failed")); else resolve(value); }
        catch (error) { reject(error); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Local session control timed out")));
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

// This Unix socket is a host-owner capability, separate from browser passkeys.
// It intentionally exposes only local-session dispatch, never arbitrary API calls.
export async function startSessionControl(dataDir: string, service: TaskService) {
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
  const app = createSessionApp(service);
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
