import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";
import type { TerminalFrame } from "@palmagent/shared/terminals";
import type { InstallConfig } from "./config.js";
import { acquireUpdateLock } from "./update-state.js";
import { userConfigPath } from "./user-config.js";
import { verifyActiveExecutionCompatibility } from "./execution-release.js";
import { terminalPlatform, type TerminalPlatform } from "../terminal/adapters.js";
import { TerminalStore } from "../terminal/store.js";
import { ensurePrivateDirectory, writePrivateFileAtomic } from "../private-files.js";

/** Exercise the same authenticated public path as the browser, including screen restoration. */
export async function probeTerminalConnection(origin: string, cookie: string, id: string, version: string,
  command: (marker: string) => string, signal: AbortSignal) {
  const marker = "PALMAGENT_PROBE_" + randomBytes(12).toString("hex");
  for (const restore of [false, true]) {
    const response = await fetch(`${origin}/api/terminals/${id}/attach-ticket`, {
      method: "POST", headers: { origin, cookie, "content-type": "application/json", "x-palmagent-version": version },
      body: "{}", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) throw new Error("Public terminal authentication or attach-ticket request failed");
    const ticket = await response.json() as { ticket?: string; protocol?: number };
    if (!ticket.ticket || ticket.protocol !== 1) throw new Error("Terminal attach-ticket response is incompatible");
    await new Promise<void>((resolve, reject) => {
      const url = new URL(`/api/terminals/${id}/stream`, origin); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url, { headers: { origin, cookie }, handshakeTimeout: 10_000, maxPayload: 4_000_000, followRedirects: false });
      let output = "", sent = false, settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal.removeEventListener("abort", aborted);
        socket.terminate(); error ? reject(error) : resolve();
      };
      const aborted = () => finish(new Error("Terminal diagnostic was interrupted"));
      const timer = setTimeout(() => finish(new Error(restore ? "Terminal screen restoration timed out" : "Public terminal input/output timed out")), 15_000);
      signal.addEventListener("abort", aborted, { once: true });
      socket.on("error", () => finish(new Error("Public terminal WebSocket connection failed")));
      if (signal.aborted) { aborted(); return; }
      socket.on("close", () => finish(new Error("Public terminal WebSocket closed before verification")));
      socket.on("open", () => socket.send(JSON.stringify({ type: "attach", ...ticket })));
      socket.on("message", data => {
        try {
          const frame = JSON.parse(data.toString()) as TerminalFrame;
          if ("seq" in frame) socket.send(JSON.stringify({ type: "ack", seq: frame.seq }));
          if (frame.type === "snapshot") {
            if (restore) { if (!frame.data.includes(marker)) throw new Error("Reconnected terminal did not restore its screen"); finish(); }
            else socket.send(JSON.stringify({ type: "claim-control" }));
          } else if (frame.type === "control" && frame.writable && !restore && !sent) {
            sent = true; socket.send(JSON.stringify({ type: "input", epoch: frame.epoch, data: command(marker) }));
          } else if (frame.type === "output" && !restore) {
            output = (output + frame.data).slice(-100_000);
            if (output.includes(marker)) finish();
          } else if (frame.type === "exit" || frame.type === "error") throw new Error("Diagnostic shell stopped before verification");
        } catch (error) { finish(error instanceof Error ? error : new Error("Invalid diagnostic response")); }
      });
    });
  }
}

/** Owner-only, bounded diagnostic. No credentials or shell output are returned or logged. */
export async function diagnoseTerminal(cfg: InstallConfig, options: {
  platform?: TerminalPlatform;
  probe?: typeof probeTerminalConnection;
} = {}): Promise<{ status: "passed"; checks: string[] }> {
  if (cfg.mode !== "package" || !cfg.executionNode || !cfg.pkgDir) throw new Error("Terminal diagnostics require a package installation with retained runtimes");
  if (userInfo().username !== cfg.user || statSync(cfg.dbPath).uid !== process.getuid?.()) throw new Error("Run terminal diagnostics as the installation owner");
  if (cfg.authOrigin !== `https://${cfg.domain}`) throw new Error("Terminal diagnostics require the installation's exact HTTPS origin");
  const platform = options.platform ?? terminalPlatform(true);
  if (!platform.supervisor.capabilities.available) throw new Error(platform.supervisor.capabilities.reason ?? "Terminal services unavailable");
  if (!platform.shell.diagnosticCommand) throw new Error("Terminal diagnostics are not supported by this shell adapter");
  const unlock = acquireUpdateLock(dirname(userConfigPath()));
  const controller = new AbortController();
  const interrupted = () => controller.abort();
  process.once("SIGINT", interrupted); process.once("SIGTERM", interrupted);
  let store: TerminalStore | undefined, db: Database.Database | undefined, id: string | undefined, scratch: string | undefined;
  const token = randomBytes(32).toString("base64url");
  let stopped = false;
  try {
    verifyActiveExecutionCompatibility(cfg);
    await platform.supervisor.inspect?.();
    ensurePrivateDirectory(cfg.dataDir);
    scratch = mkdtempSync(join(cfg.dataDir, "terminal-diagnostic-"));
    store = new TerminalStore(join(cfg.dataDir, "terminals"));
    const record = store.reserve({ diagnostic: true, requestId: randomUUID(), repoId: "diagnostic", title: "Terminal diagnostic",
      initialCwd: scratch, release: cfg.pkgDir, node: cfg.executionNode, directory: store.directory, cols: 120, rows: 24 }).record;
    id = record.id;
    writePrivateFileAtomic(join(store.directory, id + ".json"), JSON.stringify({ id, protocol: record.protocol, directory: record.directory, release: record.release, node: record.node }));
    await platform.supervisor.launch(record);
    const deadline = Date.now() + 30_000;
    while (store.get(id)?.state !== "running") {
      if (controller.signal.aborted) throw new Error("Terminal diagnostic was interrupted");
      const current = store.get(id);
      if (!current || current.state !== "starting") throw new Error(current?.startError ?? "Diagnostic shell failed to start");
      if (Date.now() >= deadline) throw new Error("Diagnostic shell readiness timed out");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    db = new Database(cfg.dbPath, { fileMustExist: true }); db.pragma("busy_timeout = 5000");
    const now = Date.now();
    db.prepare("INSERT INTO auth_sessions(token, created_at, expires_at, label) VALUES (?, ?, ?, ?)").run(token, now, now + 120_000, "Temporary terminal diagnostic");
    const env = readFileSync(join(cfg.dataDir, "install.env"), "utf8");
    const cookieName = /^AUTH_COOKIE_NAME=(.+)$/m.exec(env)?.[1].trim() ?? "palmagent_session";
    if (!/^[\w-]+$/.test(cookieName)) throw new Error("Invalid installation session cookie name");
    const version = String(JSON.parse(readFileSync(join(cfg.pkgDir, "package.json"), "utf8")).version);
    await (options.probe ?? probeTerminalConnection)(cfg.authOrigin, `${cookieName}=${token}`, id, version, platform.shell.diagnosticCommand, controller.signal);
    return { status: "passed", checks: ["service permissions", "PTY readiness", "public WebSocket input/output", "screen restoration", "diagnostic cleanup"] };
  } finally {
    try {
      if (id && store) {
        try {
          await platform.supervisor.terminate(store.get(id)!);
          stopped = true; store.update(id, { state: "exited" }); store.removeDiagnostic(id);
          try { unlinkSync(join(store.directory, id + ".json")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        } catch {
          if (store.get(id)) store.update(id, { diagnosticCleanupFailed: true });
          throw new Error(`Diagnostic shell cleanup could not be confirmed. Inspect terminal ${id} with palmagent terminal list.`); }
      }
    } finally {
      try { db?.prepare("DELETE FROM auth_sessions WHERE token = ?").run(token); }
      finally {
        try {
          try { db?.close(); } finally { store?.close(); }
          if (scratch && (!id || stopped)) rmSync(scratch, { recursive: true, force: true });
        } finally { process.off("SIGINT", interrupted); process.off("SIGTERM", interrupted); unlock(); }
      }
    }
  }
}
