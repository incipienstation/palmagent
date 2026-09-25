import { Hono } from "hono";
import { z } from "zod";
import { VoiceStartSchema, VoiceStopSchema } from "@palmagent/shared";
import { jsonBody, params } from "../input.js";
import type { HttpDependencies } from "../types.js";

export function voiceRoutes({ service }: Pick<HttpDependencies, "service">) {
  const id = params(z.object({ id: z.string().uuid() }));
  return new Hono()
    .post("/", jsonBody(VoiceStartSchema), async c => {
      const { context, sdp } = c.req.valid("json");
      return c.json(await service.startVoice(context, sdp, c.req.raw.signal), 200);
    })
    .post("/:id/heartbeat", id, c => { service.voice.touch(c.req.valid("param").id); return c.json({ ok: true as const }, 200); })
    .delete("/:id", id, jsonBody(VoiceStopSchema), c => {
      const { timings } = c.req.valid("json");
      service.voice.stop(c.req.valid("param").id, timings);
      return c.json({ ok: true as const }, 200);
    });
}
