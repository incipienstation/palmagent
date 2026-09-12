import { Hono, type Context } from "hono";
import { AnswerSchema, ApproveSchema, CreateTaskSchema, EmptyBodySchema, FollowupSchema, IdParamsSchema, SteerSchema, TaskQuerySchema } from "@palmagent/shared/requests";
import { body, parse } from "../input.js";
import type { HttpDependencies } from "../types.js";

export function taskRoutes({ service }: HttpDependencies) {
  const app = new Hono();
  const id = (c: Context) => parse(IdParamsSchema, c.req.param()).id;
  app.get("/", (c) => c.json({ tasks: service.listTasks(parse(TaskQuerySchema, c.req.query()).status) }));
  app.post("/", async (c) => c.json({ task: service.createTask(await body(c, CreateTaskSchema)) }, 201));
  app.get("/:id", (c) => c.json({ task: service.getTask(id(c)) }));
  app.delete("/:id", (c) => c.json({ task: service.archive(id(c)) }));
  app.post("/:id/handoff", (c) => c.json(service.handoff(id(c))));
  app.post("/:id/followup", async (c) => {
    const input = await body(c, FollowupSchema);
    return c.json({ task: service.followup(id(c), input.prompt, input.images, input.model, input.effort, input.permission) }, 202);
  });
  app.post("/:id/steer", async (c) => {
    const input = await body(c, SteerSchema);
    return c.json(service.steer(id(c), input.text, input.images, input.model, input.effort, input.permission));
  });
  app.post("/:id/approve", async (c) => {
    const input = await body(c, ApproveSchema);
    return c.json({ task: service.approve(id(c), input.decision, input.scope) });
  });
  app.post("/:id/answer", async (c) => c.json({ task: service.answer(id(c), await body(c, AnswerSchema)) }));
  app.post("/:id/stop", async (c) => { await body(c, EmptyBodySchema); return c.json({ task: service.stop(id(c)) }); });
  app.post("/:id/cancel", async (c) => { await body(c, EmptyBodySchema); return c.json({ task: service.cancel(id(c)) }); });
  return app;
}
