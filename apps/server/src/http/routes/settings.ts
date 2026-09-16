import { Hono } from "hono";
import { RepoSettingsChangeSchema } from "@palmagent/shared/requests";
import { HttpError } from "../../service.js";
import { body } from "../input.js";
import type { HttpDependencies } from "../types.js";

export function settingsRoutes({ settings, auth }: HttpDependencies) {
  const app = new Hono();
  const status = () => ({ ...settings.get(), writable: auth.enabled });
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.get("/", (c) => c.json(status()));
  app.patch("/", async (c) => {
    if (!auth.enabled) throw new HttpError(403, "Sign-in must be enabled to change Space search settings.");
    settings.change(await body(c, RepoSettingsChangeSchema));
    return c.json(status());
  });
  return app;
}
