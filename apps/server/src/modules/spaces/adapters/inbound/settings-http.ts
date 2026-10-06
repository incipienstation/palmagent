import { Hono } from "hono";
import { RepoSettingsChangeSchema } from "@palmagent/shared/requests";
import { requireSignIn } from "../../../../platform/http/middleware.js";
import { jsonBody } from "../../../../platform/http/input.js";
import type { HttpDependencies } from "./http-dependencies.js";

export function settingsRoutes({ settings, auth }: Pick<HttpDependencies, "settings" | "auth">) {
  const app = new Hono();
  const status = () => ({ ...settings.get(), writable: auth.enabled });
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  return app
    .get("/", (c) => c.json(status(), 200))
    .patch("/", requireSignIn(auth.enabled, "Sign-in must be enabled to change Space search settings."), jsonBody(RepoSettingsChangeSchema), (c) => {
      settings.change(c.req.valid("json"));
      return c.json(status(), 200);
    });
}
