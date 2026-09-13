import { Hono } from "hono";
import { UpdateSettingsChangeSchema } from "@palmagent/shared/requests";
import type { UpdateSettingsState, UpdateSettingsStatus } from "@palmagent/shared";
import { HttpError } from "../../service.js";
import { body } from "../input.js";
import type { HttpDependencies } from "../types.js";

export function updateSettingsRoutes({ updates, auth, build }: HttpDependencies) {
  const app = new Hono();
  const status = (state: UpdateSettingsState): UpdateSettingsStatus => ({
    ...state, currentVersion: build?.version ?? null,
    availability: !auth.enabled && state.availability === "available" ? "authentication-required" : state.availability,
  });
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.get("/", async (c) => c.json(status(updates ? await updates.status() : { availability: "unavailable", settings: null })));
  app.patch("/", async (c) => {
    // Unlike ordinary dev task controls, host settings require product auth to be
    // enabled. The shared middleware has already verified the signed-in session.
    if (!auth.enabled) throw new HttpError(403, "Sign-in must be enabled to change installation settings.");
    const change = await body(c, UpdateSettingsChangeSchema);
    if (!updates) throw new HttpError(503, "Update settings are unavailable.");
    return c.json(status(await updates.change(change)));
  });
  return app;
}
