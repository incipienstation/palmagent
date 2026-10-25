import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { InstallConfig } from "../../domain/installation.js";
import type { DiagnosticSessions } from "../../application/ports/outbound/diagnostic-sessions.js";
import { withDiagnosticSession } from "./diagnostic-session.js";

/** Recognize a complete SSE data frame without retaining or printing application payloads. */
async function receiveSse(response: Response): Promise<void> {
  if (!response.ok || !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") || !response.body) {
    await response.body?.cancel();
    throw new Error("Public SSE endpoint did not return an authenticated event stream");
  }
  const reader = response.body.getReader();
  let prefix = "", length = 0, data = false, bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Public SSE stream closed before delivering a complete data frame");
      bytes += chunk.value.length;
      if (bytes > 64 * 1024 * 1024) throw new Error("Public SSE frame exceeded the diagnostic byte limit");
      for (const byte of chunk.value) {
        if (byte === 13) continue;
        if (byte === 10) {
          if (length === 0) { if (data) return; }
          else data ||= prefix === "data:";
          prefix = ""; length = 0;
        } else {
          if (length < 5) prefix += String.fromCharCode(byte);
          length++;
        }
      }
    }
  } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
}

/** Uses the browser's public routes with ordinary TLS verification and no redirects. */
export async function probePublicConnection(origin: string, cookie: string, version: string | undefined,
  signal: AbortSignal, timeoutMs = 10_000): Promise<void> {
  const request = (path: string, authenticated = false) => fetch(`${origin}${path}`, {
    headers: authenticated ? { cookie, origin } : {}, redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  });
  const health = await request("/api/health");
  if (!health.ok) { await health.body?.cancel(); throw new Error("Public health request failed"); }
  const status = await health.json().catch(() => { throw new Error("Public health endpoint returned invalid JSON"); }) as { ok?: boolean; build?: { version?: string } };
  if (status.ok !== true || (version !== undefined && status.build?.version !== version)) throw new Error("Public application health or version does not match the installation");
  const shell = await request("/");
  await shell.body?.cancel();
  if (!shell.ok || !/^text\/html(?:\s*;|$)/i.test(shell.headers.get("content-type") ?? "")) throw new Error("Public application shell is unavailable");
  const auth = await request("/api/auth/me", true);
  if (!auth.ok) { await auth.body?.cancel(); throw new Error("Public authentication request failed"); }
  const authenticated = await auth.json().catch(() => { throw new Error("Public authentication endpoint returned invalid JSON"); }) as { authenticated?: boolean; required?: boolean };
  if (authenticated.required !== true || authenticated.authenticated !== true) throw new Error("Public authentication is disabled or did not recognize the diagnostic session");
  await receiveSse(await request("/api/stream?snapshots=1", true));
}

export function createConnectionDiagnostics(sessions: DiagnosticSessions) {
  return async (cfg: InstallConfig, probe = probePublicConnection) => withDiagnosticSession(cfg, sessions, async (cookie, signal) => {
    const version = cfg.mode === "package" && cfg.pkgDir
      ? String(JSON.parse(readFileSync(join(cfg.pkgDir, "package.json"), "utf8")).version) : undefined;
    await probe(cfg.authOrigin, cookie, version, signal);
    return { status: "passed" as const, origin: cfg.authOrigin, vantage: "host" as const,
      checks: [version === undefined ? "public HTTPS health" : "public HTTPS health/version", "app shell", "authenticated HTTP", "SSE delivery", "diagnostic cleanup"] };
  });
}
