import { SubmitMessageSchema, MessageActionSchema } from "@palmagent/shared";
import { Hono } from "hono";
import { AnswerSchema, ApproveSchema, CreateTaskSchema, EmptyBodySchema, FollowupSchema, HistoryQuerySchema, IdParamsSchema, MessageParamsSchema, RenameTaskSchema, SteerSchema, TaskQuerySchema } from "@palmagent/shared/requests";
import { jsonBody, query, params } from "../input.js";
import type { HttpDependencies } from "../types.js";
import { TaskImageQuerySchema } from "@palmagent/shared/requests";
import { readTaskImage } from "../../task-images.js";

export function taskRoutes({ service, db }: HttpDependencies) {
  const app = new Hono();
  return app
    .get("/", query(TaskQuerySchema), (c) => c.json({ tasks: service.listTasks(c.req.valid("query").status) }, 200))
    .post("/", jsonBody(CreateTaskSchema), (c) => c.json({ task: service.createTask(c.req.valid("json")) }, 201))
    .get("/:id", params(IdParamsSchema), (c) => c.json({ task: service.getTask(c.req.valid("param").id) }, 200))
    .get("/:id/image", params(IdParamsSchema), query(TaskImageQuerySchema), async (c) => {
      c.header("Cache-Control", "no-store");
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Cross-Origin-Resource-Policy", "same-origin");
      c.header("Content-Security-Policy", "default-src 'none'; sandbox");
      const task = service.getTask(c.req.valid("param").id);
      const image = await readTaskImage(task.worktreePath, c.req.valid("query").path);
      return c.body(new Uint8Array(image.bytes), 200, { "Content-Type": image.mediaType });
    })
    .get("/:id/account-limits", params(IdParamsSchema), async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(await service.accountLimits(c.req.valid("param").id), 200);
    })
    .patch("/:id", params(IdParamsSchema), jsonBody(RenameTaskSchema), (c) => {
      const input = c.req.valid("json");
      return c.json({ task: service.rename(c.req.valid("param").id, input.title) }, 200);
    })
    .get("/:id/history", params(IdParamsSchema), query(HistoryQuerySchema), (c) => {
      const taskId = c.req.valid("param").id;
      service.getTask(taskId);
      const { before } = c.req.valid("query");
      c.header("cache-control", "no-store");
      return c.json(db.historyPage(taskId, before), 200);
    })
    .delete("/:id", params(IdParamsSchema), (c) => c.json({ task: service.archive(c.req.valid("param").id) }, 200))
    .post("/:id/handoff", params(IdParamsSchema), (c) => c.json(service.handoff(c.req.valid("param").id), 200))
    .post("/:id/messages", params(IdParamsSchema), jsonBody(SubmitMessageSchema), (c) => c.json(service.submitMessage(c.req.valid("param").id, c.req.valid("json")), 202))
    .post("/:id/messages/:messageId", params(MessageParamsSchema), jsonBody(MessageActionSchema), (c) => c.json(service.messageAction(c.req.valid("param").id, c.req.valid("param").messageId, c.req.valid("json")), 200))
    .post("/:id/queue/resume", params(IdParamsSchema), jsonBody(EmptyBodySchema), (c) => c.json(service.messages.resume(c.req.valid("param").id), 200))
    .post("/:id/followup", params(IdParamsSchema), jsonBody(FollowupSchema), (c) => {
      const input = c.req.valid("json");
      return c.json({ task: service.followup(c.req.valid("param").id, input.prompt, input.images, input.model, input.effort, input.permission) }, 202);
    })
    .post("/:id/steer", params(IdParamsSchema), jsonBody(SteerSchema), (c) => {
      const input = c.req.valid("json");
      return c.json(service.steer(c.req.valid("param").id, input.text, input.images, input.model, input.effort, input.permission), 200);
    })
    .post("/:id/approve", params(IdParamsSchema), jsonBody(ApproveSchema), (c) => {
      const input = c.req.valid("json");
      return c.json({ task: service.approve(c.req.valid("param").id, input.decision, input.scope) }, 200);
    })
    .post("/:id/answer", params(IdParamsSchema), jsonBody(AnswerSchema), async (c) => c.json({ task: await service.answer(c.req.valid("param").id, c.req.valid("json")) }, 200))
    .post("/:id/stop", params(IdParamsSchema), jsonBody(EmptyBodySchema), (c) => c.json({ task: service.stop(c.req.valid("param").id) }, 200))
    .post("/:id/cancel", params(IdParamsSchema), jsonBody(EmptyBodySchema), (c) => c.json({ task: service.cancel(c.req.valid("param").id) }, 200));
}
