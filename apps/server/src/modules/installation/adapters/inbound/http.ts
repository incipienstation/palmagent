import { Hono } from "hono";
import { UpdateSettingsChangeSchema } from "@palmagent/shared/requests";
import { UpdateActionSchema } from "@palmagent/shared/updates";
import type { UpdateSettingsState, UpdateSettingsStatus } from "@palmagent/shared";
import { ApplicationError } from "../../../../kernel/errors.js";
import { requireSignIn } from "../../../../platform/http/middleware.js";
import { jsonBody } from "../../../../platform/http/input.js";
import type { HttpDependencies } from "./http-dependencies.js";

export function updateSettingsRoutes({ updates, auth, build }: Pick<HttpDependencies, "updates" | "auth" | "build">) {
  const app = new Hono();
  const status = (state: UpdateSettingsState): UpdateSettingsStatus => ({
    ...state, currentVersion: build?.version ?? null,
    availability: !auth.enabled && state.availability === "available" ? "authentication-required" : state.availability,
  });
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  return app
    .get("/", async (c) => c.json(status(updates ? await updates.status() : { availability: "unavailable", settings: null }), 200))
    .patch("/", requireSignIn(auth.enabled, "Sign-in must be enabled to change installation settings."), jsonBody(UpdateSettingsChangeSchema), async (c) => {
      // Unlike ordinary dev task controls, host settings require product auth to be
      // enabled. The shared middleware has already verified the signed-in session.
      const change = c.req.valid("json");
      if (!updates) throw new ApplicationError("service_unavailable", "Update settings are unavailable.");
      return c.json(status(await updates.change(change)), 200);
    })
    .post("/", requireSignIn(auth.enabled, "Sign-in must be enabled to manage updates."), jsonBody(UpdateActionSchema), async (c) => {
      const action = c.req.valid("json");
      if (!updates) throw new ApplicationError("service_unavailable", "Update settings are unavailable.");
      return c.json(status(await updates.action(action)), 200);
    });
}
