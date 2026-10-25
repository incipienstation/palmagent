import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { InstallConfig } from "../../domain/installation.js";
import type { DiagnosticSessions } from "../../application/ports/outbound/diagnostic-sessions.js";
import { acquireUpdateLock } from "./update-state.js";
import { userConfigPath } from "./user-config.js";
import { parseEnvFile } from "./config.js";

/** Owner-only, bounded authentication. Never return or log the temporary cookie. */
export async function withDiagnosticSession<T>(cfg: InstallConfig, sessions: DiagnosticSessions,
  work: (cookie: string, signal: AbortSignal) => Promise<T>): Promise<T> {
  if (userInfo().username !== cfg.user || statSync(cfg.dbPath).uid !== process.getuid?.()) throw new Error("Run diagnostics as the installation owner");
  if (cfg.authOrigin !== `https://${cfg.domain}`) throw new Error("Diagnostics require the installation's exact HTTPS origin");
  const env = parseEnvFile(readFileSync(join(cfg.dataDir, "install.env"), "utf8"));
  const cookieName = env.AUTH_COOKIE_NAME ?? "palmagent_session";
  if (!/^[\w-]+$/.test(cookieName)) throw new Error("Invalid installation session cookie name");
  const unlock = acquireUpdateLock(dirname(userConfigPath()));
  const controller = new AbortController();
  const interrupted = () => controller.abort();
  const timer = setTimeout(interrupted, 90_000);
  process.once("SIGINT", interrupted); process.once("SIGTERM", interrupted);
  const token = randomBytes(32).toString("base64url");
  let store: ReturnType<DiagnosticSessions["open"]> | undefined;
  let created = false;
  try {
    store = sessions.open(cfg.dbPath);
    const now = Date.now();
    store.create(token, now, now + 120_000, "Temporary connection diagnostic");
    created = true;
    return await work(`${cookieName}=${token}`, controller.signal);
  } finally {
    try { if (created) store!.delete(token); }
    finally {
      try { store?.close(); }
      finally { clearTimeout(timer); process.off("SIGINT", interrupted); process.off("SIGTERM", interrupted); unlock(); }
    }
  }
}
