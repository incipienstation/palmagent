import { guardSessionStream } from "./session-stream.js";
import type { ApiErrorResponse } from "@palmagent/shared/http";
import { MESSAGE_PROTOCOL_HEADER, MESSAGE_PROTOCOL_VERSION } from "@palmagent/shared/http";
import type { MiddlewareHandler } from "hono";
import { ApplicationError } from "../../kernel/errors.js";
import { getCookie } from "hono/cookie";
import type { HttpRuntime, SessionAccess } from "./types.js";

export function versionHeader({ build }: HttpRuntime): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
    if (build && c.req.path.startsWith("/api/")) c.header("X-Palmagent-Version", build.version);
    await next();
  };
}

export function authenticate({ auth, config }: HttpRuntime & { auth: SessionAccess }): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    const publicRoute = (path === "/api/health" && c.req.method === "GET") || path.startsWith("/api/auth/");
    const token = getCookie(c, config.cookieName);
    if (auth.enabled && path.startsWith("/api/")) {
      if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.req.header("origin") !== auth.origin) {
        return c.json({ error: "Same-origin request required" }, 403);
      }
      if (!publicRoute && !auth.verifySession(token)) return c.json({ error: "unauthorized" }, 401);
    }
    await next();
    if (auth.enabled && c.res.body && c.res.headers.get("content-type")?.startsWith("text/event-stream")) {
      c.res = guardSessionStream(c.res, () => auth.sessionValid(token));
    }
  };
}

export function securityHeaders(origin: string): MiddlewareHandler {
  // Some browsers do not match HTTPS 'self' against a secure WebSocket URL.
  const websocketOrigin = origin ? new URL(origin) : undefined;
  if (websocketOrigin) websocketOrigin.protocol = "wss:";
  return async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Security-Policy", `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' ${websocketOrigin?.origin ?? ""} https://api.openai.com; media-src 'self' data: blob: https:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
    await next();
  };
}

export function requireCurrentClient({ build }: HttpRuntime): MiddlewareHandler {
  return async (c, next) => {
    const version = c.req.header("x-palmagent-version");
    const path = c.req.path;
    const compatibleMessage = c.req.method === "POST" &&
      (path === "/api/tasks" || /^\/api\/tasks\/[^/]+\/messages$/.test(path)) &&
      c.req.header(MESSAGE_PROTOCOL_HEADER) === MESSAGE_PROTOCOL_VERSION;
    if (build && version && version !== build.version && path.startsWith("/api/") &&
        !compatibleMessage && !path.startsWith("/api/auth/") && !["GET", "HEAD"].includes(c.req.method)) {
      return c.json({ error: "Palmagent was updated. Refresh the app before making changes.", code: "update-required" } satisfies ApiErrorResponse, 409);
    }
    await next();
  };
}

export function requestAdmission({ shutdown }: HttpRuntime): MiddlewareHandler {
  return async (c, next) => {
    // Hono dispatches HEAD through GET. Preserve strict paths and prevent HEAD
    // from allocating a live SSE subscription.
    if (c.req.method === "HEAD") return c.notFound();
    try { decodeURIComponent(c.req.path); } catch { return c.json({ error: "invalid URL encoding" }, 400); }
    if (shutdown?.aborted) return c.json({ error: "server is shutting down", code: "update_in_progress" } satisfies ApiErrorResponse, 503);
    await next();
  };
}

// Host settings require enabled sign-in even in development mode. Run this
// before parsing a write, preserving the existing admission/error precedence.
export function requireSignIn(enabled: boolean, message: string): MiddlewareHandler {
  return async (_c, next) => {
    if (!enabled) throw new ApplicationError("forbidden", message);
    await next();
  };
}
