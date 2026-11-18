import type { MiddlewareHandler } from "hono";
import type { PerformanceMeasurements } from "../../kernel/performance.js";

/** A closed taxonomy, never a URL, identifier, query, or user-supplied label. */
export function requestOperation(path: string, method: string, format?: string): string | undefined {
  if (!path.startsWith("/api/") || path.startsWith("/api/settings/telemetry")) return undefined;
  if (path === "/api/stream" || path === "/api/agents/stream") return undefined;
  if (path === "/api/health") return "http.health";
  if (method === "GET") {
    if (path === "/api/usage") return "http.read.usage";
    if (/^\/api\/tasks\/[^/]+\/history\/details$/.test(path)) return "http.read.details";
    if (/^\/api\/tasks\/[^/]+\/history\/steps$/.test(path)) return "http.read.steps";
    if (format === "transcript") {
      if (/^\/api\/tasks\/[^/]+\/history$/.test(path)) return "http.read.transcript";
      if (/^\/api\/tasks\/[^/]+\/history\/changes$/.test(path)) return "http.read.changes";
    }
  }
  const read = method === "GET" || method === "HEAD";
  if (/^\/api\/tasks(?:\/|$)/.test(path)) return read ? "http.tasks.read" : "http.tasks.write";
  if (read && /^\/api\/repos(?:\/|$)/.test(path)) return "http.spaces.read";
  if (read && /^\/api\/routines(?:\/|$)/.test(path)) return "http.routines.read";
  if (read && /^\/api\/terminals(?:\/|$)/.test(path)) return "http.terminals.read";
  if (read && /^\/api\/agents\/(?:claude|codex)\/limits$/.test(path)) return "http.agents.limits";
  if (/^\/api\/agents(?:\/|$)/.test(path)) return read ? "http.agents.read" : "http.agents.write";
  if (read && path === "/api/model-catalog") return "http.models.read";
  if (read && path === "/api/skills") return "http.skills.read";
  if (/^\/api\/settings\/updates(?:\/|$)/.test(path)) return read ? "http.installation.read" : "http.installation.write";
  if (/^\/api\/settings(?:\/|$)/.test(path)) return read ? "http.settings.read" : "http.settings.write";
  return "http.request";
}
export function requestMeasurements(metrics: PerformanceMeasurements | undefined, load: { active: number }): MiddlewareHandler {
  let activeReads = 0;
  return async (c, next) => {
    const operation = requestOperation(c.req.path, c.req.method, c.req.query("format"));
    if (!metrics || !operation) return next();
    const selectedRead = operation.startsWith("http.read.");
    load.active++;
    const finish = metrics.beginOperation(operation, selectedRead ? ++activeReads : load.active);
    try { await next(); }
    finally {
      load.active--;
      if (selectedRead) {
        activeReads--;
        const status = c.res.status;
        finish(status === 503 ? "unavailable" : status >= 500 ? "error" : status >= 400 ? "client_error" : "success");
      } else {
        finish(c.error || c.res.status >= 400 ? "error" : "success");
      }
    }
  };
}
