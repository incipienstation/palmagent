import { SpaceDiscoveryService } from "../modules/spaces/application/use-cases/space-discovery.js";
import { localSpaceDiscovery } from "../modules/spaces/adapters/outbound/local-discovery.js";
import { HOST_INGRESS_REQUIREMENTS } from "@palmagent/shared";
import { voiceRoutes } from "../modules/agents/adapters/inbound/voice-http.js";
import { terminalRoutes } from "../modules/terminals/adapters/inbound/http.js";
import { Hono } from "hono";
import { authBudget } from "../platform/http/auth-budget.js";
import { bodyLimit } from "hono/body-limit";
import { StreamQuerySchema } from "@palmagent/shared/requests";
import { query } from "../platform/http/input.js";
import { versionHeader, authenticate, requireCurrentClient, requestAdmission } from "../platform/http/middleware.js";
import { SkillContextSchema } from "@palmagent/shared";
import { AGENT_CLI_COMPATIBILITY } from "@palmagent/shared";
import { handleError } from "../platform/http/errors.js";
import { authRoutes } from "../modules/auth/adapters/inbound/http.js";
import { agentRoutes } from "../modules/agents/adapters/inbound/http.js";
import { taskRoutes } from "../modules/tasks/adapters/inbound/http.js";
import { repoRoutes } from "../modules/spaces/adapters/inbound/http.js";
import { routineRoutes } from "../modules/routines/adapters/inbound/http.js";
import { pushRoutes } from "../modules/tasks/adapters/inbound/push-http.js";
import { updateSettingsRoutes } from "../modules/installation/adapters/inbound/http.js";
import { settingsRoutes } from "../modules/spaces/adapters/inbound/settings-http.js";
import { staticFiles } from "../platform/http/static.js";
import { sessionStream } from "../modules/tasks/adapters/inbound/stream.js";
import type { HttpDependencies } from "./http-dependencies.js";

export const MAX_BODY_BYTES = 1024 * 1024;
// Only task creation, messages (including queue edits), follow-up and steering
// accept base64 images. Decoded image/count limits remain in the service.
export const MAX_IMAGE_BODY_BYTES = HOST_INGRESS_REQUIREMENTS.maxBodyBytes;
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
  const api = app.get("/api/health", (c) => c.json({ ok: true, updateMaintenance: service.updating, executionProtocol: service.executionProtocol,
    activeRoutineScripts: deps.routines.activeScriptCount ?? 0, ...(deps.build ? { build: deps.build } : {}) }, 200))
    .route("/api/auth", authRoutes(deps))
    .route("/api/agents", agentRoutes(deps))
    .get("/api/compatibility", (c) => c.json({ agents: AGENT_CLI_COMPATIBILITY }, 200))
    .get("/api/model-catalog", async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(await deps.modelCatalog.get(service.providerHome("codex")), 200);
    })
    .get("/api/usage", (c) => c.json({ usage: service.usage() }, 200))
    .get("/api/stream", query(StreamQuerySchema), (c) => sessionStream(c, deps, c.req.valid("query")))
    .get("/api/skills", query(SkillContextSchema), async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(await service.availableSkills(c.req.valid("query")), 200);
    })
    .route("/api/voice", voiceRoutes(deps))
    .route("/api/terminals", terminalRoutes(deps))
    .route("/api/tasks", taskRoutes(deps))
    .route("/api", repoRoutes({ service, discovery: new SpaceDiscoveryService(localSpaceDiscovery, deps.settings, service) }))
    .route("/api/routines", routineRoutes(deps))
    .route("/api/push", pushRoutes(deps))
    .route("/api/settings/updates", updateSettingsRoutes(deps))
    .route("/api/settings/repos", settingsRoutes(deps));
  app.get("*", staticFiles(config.staticDir));
  return api;
}
