import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { DispatchSessionSchema } from "@palmagent/shared/requests";
import { body } from "../http/input.js";
import { handleError } from "../http/errors.js";
import type { TaskService } from "../service.js";

// A separate app: never mount this capability on the browser's TCP listener.
export function createSessionApp(service: Pick<TaskService, "dispatchSession">) {
  const app = new Hono();
  app.onError(handleError);
  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.use("*", bodyLimit({ maxSize: 16_384, onError: (c) => c.json({ error: "request body too large" }, 413) }));
  app.post("/dispatch", async (c) => {
    const input = await body(c, DispatchSessionSchema);
    try { return c.json({ task: service.dispatchSession(input) }); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : "Session dispatch failed" }, 409); }
  });
  return app;
}
