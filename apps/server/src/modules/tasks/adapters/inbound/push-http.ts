import { Hono } from "hono";
import { PushSubscribeSchema, PushUnsubscribeSchema } from "@palmagent/shared/requests";
import { jsonBody } from "../../../../platform/http/input.js";
import type { HttpDependencies } from "./http-dependencies.js";

export function pushRoutes({ push }: Pick<HttpDependencies, "push">) {
  const app = new Hono();
  return app
    .get("/key", (c) => c.json({ publicKey: push.getPublicKey() }, 200))
    .post("/subscribe", jsonBody(PushSubscribeSchema), (c) => { push.subscribe(c.req.valid("json").subscription); return c.json({ ok: true }, 201); })
    .post("/unsubscribe", jsonBody(PushUnsubscribeSchema), (c) => { push.unsubscribe(c.req.valid("json").endpoint); return c.json({ ok: true }, 200); });
}
