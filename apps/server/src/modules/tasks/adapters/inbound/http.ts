import { readStream } from "../../../../platform/http/read-stream.js";
import { AttachmentParamsSchema, SubmitMessageSchema, MessageActionSchema, CompactTaskSchema } from "@palmagent/shared";
import { Hono } from "hono";
import { ActivityDetailsQuerySchema, AnswerSchema, ApproveSchema, CreateTaskSchema, EmptyBodySchema, FollowupSchema, HistoryChangesQuerySchema, HistoryQuerySchema, IdParamsSchema, MessageParamsSchema, PinTaskSchema, RenameTaskSchema, SteerSchema, TaskQuerySchema } from "@palmagent/shared/requests";
import { jsonBody, query, params } from "../../../../platform/http/input.js";
import type { HttpDependencies } from "./http-dependencies.js";
import { TaskImageQuerySchema } from "@palmagent/shared/requests";

export function taskRoutes({ service, hub, config, shutdown }: Pick<HttpDependencies, "service" | "hub" | "config" | "shutdown">) {
  const app = new Hono();
  return app
    .get("/", query(TaskQuerySchema), (c) => c.json({ tasks: service.listTasks(c.req.valid("query").status) }, 200))
    .post("/", jsonBody(CreateTaskSchema), async (c) => {
      const input = c.req.valid("json");
      const skills = await service.resolveSkills({ repoId: input.repoId, agent: input.agent }, input.skills);
      return c.json({ task: service.createTask({ ...input, skills }) }, 201);
    })
    .get("/:id", params(IdParamsSchema), (c) => c.json({ task: service.getTask(c.req.valid("param").id) }, 200))
    .get("/:id/attachments/:attachmentId", params(AttachmentParamsSchema), (c) => {
      c.header("Cache-Control", "no-store");
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Cross-Origin-Resource-Policy", "same-origin");
      c.header("Content-Security-Policy", "default-src 'none'; sandbox");
      const { id, attachmentId } = c.req.valid("param");
      const attachment = service.readAttachment(id, attachmentId), size = attachment.bytes.length;
      c.header("Content-Type", attachment.mediaType);
      c.header("Accept-Ranges", "bytes");
      const range = c.req.header("If-Range") ? undefined : c.req.header("Range");
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        const start = match?.[1] ? Number(match[1]) : Math.max(0, size - Number(match?.[2]));
        const end = match?.[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
        if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
          || start >= size || start > end || (!match[1] && Number(match[2]) === 0)) {
          c.header("Content-Range", `bytes */${size}`);
          return c.body(null, 416);
        }
        c.header("Content-Range", `bytes ${start}-${end}/${size}`);
        c.header("Content-Length", String(end - start + 1));
        return c.body(new Uint8Array(attachment.bytes.subarray(start, end + 1)), 206);
      }
      c.header("Content-Length", String(size));
      return c.body(new Uint8Array(attachment.bytes), 200);
    })
    .get("/:id/image", params(IdParamsSchema), query(TaskImageQuerySchema), async (c) => {
      c.header("Cache-Control", "no-store");
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Cross-Origin-Resource-Policy", "same-origin");
      c.header("Content-Security-Policy", "default-src 'none'; sandbox");
      const image = await service.readTaskImage(c.req.valid("param").id, c.req.valid("query").path);
      return c.body(new Uint8Array(image.bytes), 200, { "Content-Type": image.mediaType });
    })
    .get("/:id/account-limits/stream", params(IdParamsSchema), c => {
      const id = c.req.valid("param").id;
      const account = () => { const task = service.getTask(id); return JSON.stringify([task.agent, task.sessionControl?.home]); };
      let current = account();
      return readStream(c, changed => {
        let off = service.observeAccountLimits(id, changed);
        const offTasks = hub.onTasks(tasks => {
          const task = tasks.find(task => task.taskId === id);
          const next = task ? JSON.stringify([task.agent, task.sessionControl?.home]) : "removed";
          if (next === current) return;
          current = next; off();
          off = task ? service.observeAccountLimits(id, changed) : () => {};
          changed();
        });
        return () => { offTasks(); off(); };
      }, config.keepAliveMs, shutdown);
    })
    .get("/:id/account-limits", params(IdParamsSchema), async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(await service.accountLimits(c.req.valid("param").id), 200);
    })
    .patch("/:id/pin", params(IdParamsSchema), jsonBody(PinTaskSchema), (c) =>
      c.json({ task: service.pin(c.req.valid("param").id, c.req.valid("json").pinned) }, 200))
    .patch("/:id", params(IdParamsSchema), jsonBody(RenameTaskSchema), (c) => {
      const input = c.req.valid("json");
      return c.json({ task: service.rename(c.req.valid("param").id, input.title) }, 200);
    })
    .get("/:id/history/details", params(IdParamsSchema), query(ActivityDetailsQuerySchema), (c) => {
      const taskId = c.req.valid("param").id;
      const { from, through } = c.req.valid("query");
      c.header("cache-control", "no-store");
      return c.json(service.taskActivityDetails(taskId, Number(from), Number(through)), 200);
    })
    .get("/:id/history/changes", params(IdParamsSchema), query(HistoryChangesQuerySchema), (c) => {
      const taskId = c.req.valid("param").id;
      const { after: afterText, through: throughText, details } = c.req.valid("query");
      const after = Number(afterText);
      const through = throughText === undefined ? undefined : Number(throughText);
      c.header("cache-control", "no-store");
      return c.json(service.taskHistoryChanges(taskId, after, through, details !== "summary"), 200);
    })
    .get("/:id/history", params(IdParamsSchema), query(HistoryQuerySchema), (c) => {
      const taskId = c.req.valid("param").id;
      const { before: beforeText, details } = c.req.valid("query");
      c.header("cache-control", "no-store");
      const before = beforeText === undefined ? undefined : Number(beforeText);
      const includeActivityDetails = details !== "summary";
      return c.json(service.taskHistory(taskId, before, includeActivityDetails), 200);
    })
    .delete("/:id", params(IdParamsSchema), (c) => c.json({ task: service.archive(c.req.valid("param").id) }, 200))
    .post("/:id/handoff", params(IdParamsSchema), (c) => c.json(service.handoff(c.req.valid("param").id), 200))
    .post("/:id/messages", params(IdParamsSchema), jsonBody(SubmitMessageSchema), async (c) => {
      const id = c.req.valid("param").id, input = c.req.valid("json");
      const skills = await service.resolveMessageSkills(id, input);
      return c.json(service.submitMessage(id, { ...input, skills }), 202);
    })
    .post("/:id/messages/:messageId", params(MessageParamsSchema), jsonBody(MessageActionSchema), async (c) => {
      const { id, messageId } = c.req.valid("param"), input = c.req.valid("json");
      const action = input.action === "save" ? { ...input, skills: await service.resolveSkills({ taskId: id }, input.skills) } : input;
      return c.json(service.messageAction(id, messageId, action), 200);
    })
    .post("/:id/queue/resume", params(IdParamsSchema), jsonBody(EmptyBodySchema), (c) => c.json(service.resumeQueue(c.req.valid("param").id), 200))
    .post("/:id/compact", params(IdParamsSchema), jsonBody(CompactTaskSchema), (c) =>
      c.json({ task: service.compact(c.req.valid("param").id, c.req.valid("json")) }, 202))
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
