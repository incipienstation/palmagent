import { connect } from "node:net";
import Database from "better-sqlite3";
import type { InstallConfig } from "./config.js";

export function runnerIsIdle(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const timer = setTimeout(() => finish(new Error("runner idle check timed out")), 3_000);
    let buffer = "";
    let settled = false;
    function finish(error?: Error, idle = false) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(idle);
    }
    socket.on("connect", () => socket.write('{"t":"hello"}\n'));
    socket.on("error", () => finish(new Error("cannot verify runner activity")));
    socket.on("close", () => finish(new Error("runner closed before reporting activity")));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 65_536) return finish(new Error("invalid runner activity response"));
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      try {
        const msg = JSON.parse(buffer.slice(0, end));
        if (msg.t !== "live" || !Array.isArray(msg.turns) || !msg.turns.every((id: unknown) => typeof id === "string")) throw new Error();
        finish(undefined, msg.turns.length === 0);
      } catch { finish(new Error("invalid runner activity response")); }
    });
  });
}

/** The health response is an event-loop barrier: prior synchronous admissions
 * have finished and subsequent admissions see the maintenance marker. */
export async function verifyUpdateIdle(cfg: InstallConfig): Promise<boolean> {
  const response = await fetch(`http://${cfg.host}:${cfg.port}/api/health`, { signal: AbortSignal.timeout(5_000) });
  const health = await response.json() as { ok?: boolean; updateMaintenance?: boolean };
  if (!response.ok || health.ok !== true || health.updateMaintenance !== true) {
    throw new Error("the running server does not support automatic update maintenance");
  }
  const db = new Database(cfg.dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT count(*) AS count FROM tasks WHERE status IN ('running','awaiting_approval','awaiting_input','queued')").get() as { count: number };
    if (row.count !== 0) return false;
  } finally { db.close(); }
  return runnerIsIdle(cfg.runnerSocket);
}
