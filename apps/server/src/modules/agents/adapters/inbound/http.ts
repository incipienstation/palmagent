import { Hono } from "hono";
import { z } from "zod";
import { ApplicationError } from "../../../../kernel/errors.js";
import { requireSignIn } from "../../../../platform/http/middleware.js";
import { jsonBody, params } from "../../../../platform/http/input.js";
import type { HttpDependencies } from "./http-dependencies.js";

const AgentParams = z.object({ agent: z.enum(["claude", "codex"]) });
const UpdateAgent = z.object({ expectedVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/).max(100) }).strict();

export function agentRoutes({ agentInstallations, service, auth }: Pick<HttpDependencies, "agentInstallations" | "service" | "auth">) {
  const installations = () => {
    if (!agentInstallations) throw new ApplicationError("service_unavailable", "Agent installation management is unavailable.");
    return agentInstallations;
  };
  const app = new Hono();
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  return app
    .get("/", async c => c.json({ installations: await installations().list(), canUpdate: auth.enabled }, 200))
    .get("/:agent/limits", params(AgentParams), async c => c.json(await service.providerAccountLimits(c.req.valid("param").agent), 200))
    .post("/:agent/update", requireSignIn(auth.enabled, "Sign-in must be enabled to update agent installations."), params(AgentParams), jsonBody(UpdateAgent), async c => {
      if (service.updating) throw new ApplicationError("conflict", "Wait for the Palmagent update to finish.");
      return c.json(await installations().update(c.req.valid("param").agent, c.req.valid("json").expectedVersion), 202);
    });
}
