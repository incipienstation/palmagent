import { voiceRoutes } from "./routes/voice.js";
import { terminalRoutes } from "./routes/terminals.js";
import { Hono } from "hono";
import { authBudget } from "./auth-budget.js";
import { bodyLimit } from "hono/body-limit";
import { StreamQuerySchema } from "@palmagent/shared/requests";
import { query } from "./input.js";
import { versionHeader, authenticate, requireCurrentClient, requestAdmission } from "./middleware.js";
import { SkillContextSchema } from "@palmagent/shared";
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

export const MAX_BODY_BYTES = 1024 * 1024;
// Only task creation, messages (including queue edits), follow-up and steering
// accept base64 images. Decoded image/count limits remain in the service.
export const MAX_IMAGE_BODY_BYTES = 48_000_000;
const IMAGE_BODY_PATH = /^\/api\/tasks(?:\/[^/]+\/(?:messages(?:\/[^/]+)?|followup|steer))?$/;
export function createApp(deps: HttpDependencies) {
  const { service, config } = deps;
  const app = new Hono();
  app.onError(handleError);
  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.use("*", versionHeader(deps), authBudget(), authenticate(deps), requireCurrentClient(deps), requestAdmission(deps));
  const limitBody = (maxSize: number) => bodyLimit({ maxSize, onError: (c) => c.json({ error: "request body too large" }, 413) });
  const standardBody = limitBody(MAX_BODY_BYTES);
  const imageBody = limitBody(MAX_IMAGE_BODY_BYTES);
  app.use("/api/*", (c, next) => (
    c.req.method === "POST" && IMAGE_BODY_PATH.test(c.req.path) ? imageBody : standardBody
  )(c, next));
  const api = app.get("/api/health", (c) => c.json({ ok: true, updateMaintenance: service.updating, executionProtocol: service.executionProtocol, ...(deps.build ? { build: deps.build } : {}) }, 200))
    .route("/api/auth", authRoutes(deps))
    .get("/api/compatibility", (c) => c.json({ agents: AGENT_CLI_COMPATIBILITY }, 200))
    .get("/api/usage", (c) => c.json({ usage: service.usage() }, 200))
    .get("/api/stream", query(StreamQuerySchema), (c) => sessionStream(c, deps, c.req.valid("query")))
    .get("/api/skills", query(SkillContextSchema), async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(await service.availableSkills(c.req.valid("query")), 200);
    })
    .route("/api/voice", voiceRoutes(deps))
    .route("/api/terminals", terminalRoutes(deps))
    .route("/api/tasks", taskRoutes(deps))
    .route("/api", repoRoutes(deps))
    .route("/api/routines", routineRoutes(deps))
    .route("/api/push", pushRoutes(deps))
    .route("/api/settings/updates", updateSettingsRoutes(deps))
    .route("/api/settings/repos", settingsRoutes(deps));
  app.get("*", staticFiles(config.staticDir));
  return api;
}
