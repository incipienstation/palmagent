import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import { AGENT_CLI_COMPATIBILITY } from "@palmagent/shared";
import { handleError } from "./errors.js";
import { authRoutes } from "./routes/auth.js";
import { taskRoutes } from "./routes/tasks.js";
import { repoRoutes } from "./routes/repos.js";
import { routineRoutes } from "./routes/routines.js";
import { pushRoutes } from "./routes/push.js";
import { updateSettingsRoutes } from "./routes/update-settings.js";
import { staticFiles } from "./static.js";
import { sessionStream } from "./stream.js";
import type { HttpDependencies } from "./types.js";

// Several base64 images fit; decoded image/count limits belong to the service.
export const MAX_BODY_BYTES = 48_000_000;
export function createApp(deps: HttpDependencies) {
  const { auth, service, config } = deps;
  const app = new Hono();
  app.onError(handleError);
  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.use("*", async (c, next) => {
    const path = c.req.path;
    const publicRoute = (path === "/api/health" && c.req.method === "GET") || path.startsWith("/api/auth/");
    if (auth.enabled && path.startsWith("/api/") && !publicRoute) {
      if (c.req.method !== "GET" && c.req.method !== "HEAD") {
        const origin = c.req.header("origin");
        if (origin) {
          let allowed = false;
          try { allowed = new URL(origin).host === c.req.header("host"); } catch { /* refuse malformed origins */ }
          if (!allowed) return c.json({ error: "cross-origin request refused" }, 403);
        }
      }
      if (!auth.verifySession(getCookie(c, config.cookieName))) return c.json({ error: "unauthorized" }, 401);
    }
    // Preserve the existing HEAD/strict-path contract; in particular HEAD must
    // never open an SSE subscription through Hono's implicit GET dispatch.
    if (c.req.method === "HEAD") return c.notFound();
    try { decodeURIComponent(path); } catch { return c.json({ error: "invalid URL encoding" }, 400); }
    if (deps.shutdown?.aborted) return c.json({ error: "server is shutting down" }, 503);
    await next();
  });
  app.use("/api/*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "request body too large" }, 413) }));
  app.get("/api/health", (c) => c.json({ ok: true, updateMaintenance: service.updating, ...(deps.build ? { build: deps.build } : {}) }));
  app.route("/api/auth", authRoutes(deps));
  app.get("/api/compatibility", (c) => c.json({ agents: AGENT_CLI_COMPATIBILITY }));
  app.get("/api/usage", (c) => c.json({ usage: service.usage() }));
  app.get("/api/stream", (c) => sessionStream(c, deps));
  app.route("/api/tasks", taskRoutes(deps));
  app.route("/api", repoRoutes(deps));
  app.route("/api/routines", routineRoutes(deps));
  app.route("/api/push", pushRoutes(deps));
  app.route("/api/settings/updates", updateSettingsRoutes(deps));
  app.get("*", staticFiles(config.staticDir));
  return app;
}
