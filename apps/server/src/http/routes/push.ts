import { Hono } from "hono";
import { PushSubscribeSchema, PushUnsubscribeSchema } from "@palmagent/shared/requests";
import { body } from "../input.js";
import type { HttpDependencies } from "../types.js";

export function pushRoutes({ push }: HttpDependencies) {
  const app = new Hono();
  app.get("/key", (c) => c.json({ publicKey: push.getPublicKey() }));
  app.post("/subscribe", async (c) => { push.subscribe((await body(c, PushSubscribeSchema)).subscription); return c.json({ ok: true }, 201); });
  app.post("/unsubscribe", async (c) => { push.unsubscribe((await body(c, PushUnsubscribeSchema)).endpoint); return c.json({ ok: true }); });
  return app;
}
