import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { StreamQuerySchema } from "@palmagent/shared/requests";
import { query } from "./input.js";
import { versionHeader, authenticate, requireCurrentClient, requestAdmission } from "./middleware.js";
import { AGENT_CLI_COMPATIBILITY } from "@palmagent/shared";
import { handleError } from "./errors.js";
import { authRoutes } from "./routes/auth.js";
import { taskRoutes } from "./routes/tasks.js";
import { repoRoutes } from "./routes/repos.js";
import { routineRoutes } from "./routes/routines.js";
import { pushRoutes } from "./routes/push.js";
import { updateSettingsRoutes } from "./routes/update-settings.js";
import { settingsRoutes } from "./routes/settings.js";
import { staticFiles } from "./static.js";
import { sessionStream } from "./stream.js";
import type { HttpDependencies } from "./types.js";

// Several base64 images fit; decoded image/count limits belong to the service.
export const MAX_BODY_BYTES = 48_000_000;
export function createApp(deps: HttpDependencies) {
  const { service, config } = deps;
  const app = new Hono();
  app.onError(handleError);
  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.use("*", versionHeader(deps), authenticate(deps), requireCurrentClient(deps), requestAdmission(deps));
  app.use("/api/*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "request body too large" }, 413) }));
  const api = app.get("/api/health", (c) => c.json({ ok: true, updateMaintenance: service.updating, executionProtocol: service.executionProtocol, ...(deps.build ? { build: deps.build } : {}) }, 200))
    .route("/api/auth", authRoutes(deps))
    .get("/api/compatibility", (c) => c.json({ agents: AGENT_CLI_COMPATIBILITY }, 200))
    .get("/api/usage", (c) => c.json({ usage: service.usage() }, 200))
    .get("/api/stream", query(StreamQuerySchema), (c) => sessionStream(c, deps, c.req.valid("query")))
    .route("/api/tasks", taskRoutes(deps))
    .route("/api", repoRoutes(deps))
    .route("/api/routines", routineRoutes(deps))
    .route("/api/push", pushRoutes(deps))
    .route("/api/settings/updates", updateSettingsRoutes(deps))
    .route("/api/settings/repos", settingsRoutes(deps));
  app.get("*", staticFiles(config.staticDir));
  return api;
}
