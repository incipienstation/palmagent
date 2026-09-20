import type { ApiErrorResponse } from "@palmagent/shared/http";
import type { MiddlewareHandler } from "hono";
import { HttpError } from "../service.js";
import { getCookie } from "hono/cookie";
import type { HttpDependencies } from "./types.js";

export function versionHeader({ build }: HttpDependencies): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
    if (build && c.req.path.startsWith("/api/")) c.header("X-Palmagent-Version", build.version);
    await next();
  };
}

export function authenticate({ auth, config }: HttpDependencies): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    const publicRoute = (path === "/api/health" && c.req.method === "GET") || path.startsWith("/api/auth/");
    if (auth.enabled && path.startsWith("/api/") && !publicRoute) {
      if (!["GET", "HEAD"].includes(c.req.method)) {
        const origin = c.req.header("origin");
        if (origin) {
          let allowed = false;
          try { allowed = new URL(origin).host === c.req.header("host"); } catch { /* refuse malformed origins */ }
          if (!allowed) return c.json({ error: "cross-origin request refused" }, 403);
        }
      }
      if (!auth.verifySession(getCookie(c, config.cookieName))) return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}

export function requireCurrentClient({ build }: HttpDependencies): MiddlewareHandler {
  return async (c, next) => {
    const version = c.req.header("x-palmagent-version");
    const path = c.req.path;
    if (build && version && version !== build.version && path.startsWith("/api/") &&
        !path.startsWith("/api/auth/") && !["GET", "HEAD"].includes(c.req.method)) {
      return c.json({ error: "Palmagent was updated. Refresh the app before making changes.", code: "update-required" } satisfies ApiErrorResponse, 409);
    }
    await next();
  };
}

export function requestAdmission({ shutdown }: HttpDependencies): MiddlewareHandler {
  return async (c, next) => {
    // Hono dispatches HEAD through GET. Preserve strict paths and prevent HEAD
    // from allocating a live SSE subscription.
    if (c.req.method === "HEAD") return c.notFound();
    try { decodeURIComponent(c.req.path); } catch { return c.json({ error: "invalid URL encoding" }, 400); }
    if (shutdown?.aborted) return c.json({ error: "server is shutting down" }, 503);
    await next();
  };
}

// Host settings require enabled sign-in even in development mode. Run this
// before parsing a write, preserving the existing admission/error precedence.
export function requireSignIn(enabled: boolean, message: string): MiddlewareHandler {
  return async (_c, next) => {
    if (!enabled) throw new HttpError(403, message);
    await next();
  };
}
