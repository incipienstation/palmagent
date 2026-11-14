import type { MiddlewareHandler } from "hono";
import type { PerformanceMeasurements } from "../../kernel/performance.js";

/** A closed taxonomy, never a URL, identifier, query, or user-supplied label. */
export function requestOperation(path: string, method: string): string | undefined {
  if (!path.startsWith("/api/") || path.startsWith("/api/settings/telemetry")) return undefined;
  if (path === "/api/stream" || path === "/api/agents/stream") return undefined;
  if (path === "/api/health") return "http.health";
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
  return async (c, next) => {
    const operation = requestOperation(c.req.path, c.req.method);
    if (!metrics || !operation) return next();
    const finish = metrics.beginOperation(operation, ++load.active);
    try { await next(); }
    finally {
      load.active--;
      finish(c.error || c.res.status >= 400 ? "error" : "success");
    }
  };
}
