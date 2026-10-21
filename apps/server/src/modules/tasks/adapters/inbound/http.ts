import { attachmentBody } from "./attachment-body.js";
import { ConversationStepDetailsQuerySchema, ExecutionRecordsQuerySchema, ConversationDetailsQuerySchema, ConversationContentQuerySchema } from "@palmagent/shared/requests";
import { FILE_MEDIA_TYPE, AttachmentParamsSchema, SubmitMessageSchema, MessageActionSchema, CompactTaskSchema } from "@palmagent/shared";
import { Hono } from "hono";
import { ActivityDetailsQuerySchema, AnswerSchema, ApproveSchema, CreateTaskSchema, EmptyBodySchema, FollowupSchema, HistoryChangesQuerySchema, HistoryQuerySchema, IdParamsSchema, MessageParamsSchema, PinTaskSchema, RenameTaskSchema, SteerSchema, TaskQuerySchema } from "@palmagent/shared/requests";
import { jsonBody, query, params } from "../../../../platform/http/input.js";
import type { HttpDependencies } from "./http-dependencies.js";
import { TaskImageQuerySchema } from "@palmagent/shared/requests";
import { SideChatSendSchema, SideChatSessionSchema } from "@palmagent/shared";

export function taskRoutes({ service }: Pick<HttpDependencies, "service">) {
  const app = new Hono();
  return app
    .get("/", query(TaskQuerySchema), (c) => c.json({ tasks: service.listTasks(c.req.valid("query").status) }, 200))
    .post("/", attachmentBody(CreateTaskSchema), async (c) => {
      const input = c.req.valid("json");
      const skills = await service.resolveSkills({ repoId: input.repoId, agent: input.agent }, input.skills);
      return c.json({ task: service.createTask({ ...input, skills }) }, 201);
    })
    .get("/:id", params(IdParamsSchema), (c) => c.json({ task: service.getTask(c.req.valid("param").id) }, 200))
    .get("/:id/side-chat", params(IdParamsSchema), c => {
      c.header("Cache-Control", "no-store");
      return c.json({ sideChat: service.getSideChat(c.req.valid("param").id) }, 200);
    })
    .post("/:id/side-chat", params(IdParamsSchema), jsonBody(EmptyBodySchema), async c =>
      c.json({ sideChat: await service.openSideChat(c.req.valid("param").id) }, 200))
    .post("/:id/side-chat/messages", params(IdParamsSchema), jsonBody(SideChatSendSchema), async c =>
      c.json({ sideChat: await service.sendSideChat(c.req.valid("param").id, c.req.valid("json")) }, 200))
    .post("/:id/side-chat/stop", params(IdParamsSchema), jsonBody(SideChatSessionSchema), async c =>
      c.json({ sideChat: await service.stopSideChat(c.req.valid("param").id, c.req.valid("json").sessionId) }, 200))
    .delete("/:id/side-chat", params(IdParamsSchema), jsonBody(SideChatSessionSchema), c =>
      c.json({ sideChat: service.endSideChat(c.req.valid("param").id, c.req.valid("json").sessionId) }, 200))
    .get("/:id/attachments/:attachmentId", params(AttachmentParamsSchema), (c) => {
      c.header("Cache-Control", "no-store");
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Cross-Origin-Resource-Policy", "same-origin");
      c.header("Content-Security-Policy", "default-src 'none'; sandbox");
      const { id, attachmentId } = c.req.valid("param");
      const attachment = service.readAttachment(id, attachmentId), size = attachment.bytes.length;
      c.header("Content-Type", attachment.mediaType);
      if (attachment.mediaType === FILE_MEDIA_TYPE) c.header("Content-Disposition", "attachment");
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
    .get("/:id/history/steps", params(IdParamsSchema), query(ConversationDetailsQuerySchema), (c) => {
      const { key, after } = c.req.valid("query");
      c.header("cache-control", "no-store");
      return c.json(service.conversationSteps(c.req.valid("param").id, Number(key), after === undefined ? undefined : Number(after)), 200);
    })
    .get("/:id/history/step-details", params(IdParamsSchema), query(ConversationStepDetailsQuerySchema), (c) => {
      const { key, step, after } = c.req.valid("query");
      c.header("cache-control", "no-store");
      return c.json(service.conversationStepDetails(c.req.valid("param").id, Number(key), Number(step), after === undefined ? undefined : Number(after)), 200);
    })
    .get("/:id/history/records", params(IdParamsSchema), query(ExecutionRecordsQuerySchema), (c) => {
      const { before } = c.req.valid("query");
      c.header("cache-control", "no-store");
      return c.json(service.executionRecords(c.req.valid("param").id, before === undefined ? undefined : Number(before)), 200);
    })
    .get("/:id/history/record-content", params(IdParamsSchema), query(ConversationContentQuerySchema), (c) => {
      const { key, version, offset } = c.req.valid("query");
      c.header("cache-control", "no-store");
      return c.json(service.executionRecordContent(c.req.valid("param").id, Number(key), version, Number(offset)), 200);
    })
    .get("/:id/history/items", params(IdParamsSchema), query(ConversationDetailsQuerySchema), (c) => {
      const { key, after } = c.req.valid("query");
      c.header("cache-control", "no-store");
      return c.json(service.conversationDetails(c.req.valid("param").id, Number(key), after === undefined ? undefined : Number(after)), 200);
    })
    .get("/:id/history/content", params(IdParamsSchema), query(ConversationContentQuerySchema), (c) => {
      const { key, version, offset, member } = c.req.valid("query");
      c.header("cache-control", "no-store");
      return c.json(service.conversationContent(c.req.valid("param").id, Number(key), version, Number(offset), member === undefined ? undefined : Number(member)), 200);
    })
    .get("/:id/history/details", params(IdParamsSchema), query(ActivityDetailsQuerySchema), (c) => {
      const taskId = c.req.valid("param").id;
      const { from, through } = c.req.valid("query");
      c.header("cache-control", "no-store");
      return c.json(service.taskActivityDetails(taskId, Number(from), Number(through)), 200);
    })
    .get("/:id/history/changes", params(IdParamsSchema), query(HistoryChangesQuerySchema), (c) => {
      const taskId = c.req.valid("param").id;
      const { after: afterText, through: throughText, details, format, afterKey } = c.req.valid("query");
      const after = Number(afterText);
      const through = throughText === undefined ? undefined : Number(throughText);
      c.header("cache-control", "no-store");
      return c.json(format === "transcript" ? service.conversationChanges(taskId, after, through, afterKey === undefined ? undefined : Number(afterKey))
        : service.taskHistoryChanges(taskId, after, through, details !== "summary"), 200);
    })
    .get("/:id/history", params(IdParamsSchema), query(HistoryQuerySchema), (c) => {
      const taskId = c.req.valid("param").id;
      const { before: beforeText, details, format } = c.req.valid("query");
      c.header("cache-control", "no-store");
      const before = beforeText === undefined ? undefined : Number(beforeText);
      const includeActivityDetails = details !== "summary";
      return c.json(format === "transcript" ? service.conversationPage(taskId, before) : service.taskHistory(taskId, before, includeActivityDetails), 200);
    })
    .delete("/:id", params(IdParamsSchema), (c) => c.json({ task: service.archive(c.req.valid("param").id) }, 200))
    .post("/:id/handoff", params(IdParamsSchema), (c) => c.json(service.handoff(c.req.valid("param").id), 200))
    .post("/:id/messages", params(IdParamsSchema), attachmentBody(SubmitMessageSchema), async (c) => {
      const id = c.req.valid("param").id, input = c.req.valid("json");
      const skills = await service.resolveMessageSkills(id, input);
      return c.json(service.submitMessage(id, { ...input, skills }), 202);
    })
    .post("/:id/messages/:messageId", params(MessageParamsSchema), attachmentBody(MessageActionSchema), async (c) => {
      const { id, messageId } = c.req.valid("param"), input = c.req.valid("json");
      const action = input.action === "save" ? { ...input, skills: await service.resolveSkills({ taskId: id }, input.skills) } : input;
      return c.json(service.messageAction(id, messageId, action), 200);
    })
    .post("/:id/queue/resume", params(IdParamsSchema), jsonBody(EmptyBodySchema), (c) => c.json(service.resumeQueue(c.req.valid("param").id), 200))
    .post("/:id/compact", params(IdParamsSchema), jsonBody(CompactTaskSchema), (c) =>
      c.json({ task: service.compact(c.req.valid("param").id, c.req.valid("json")) }, 202))
    .post("/:id/followup", params(IdParamsSchema), attachmentBody(FollowupSchema), (c) => {
      const input = c.req.valid("json");
      return c.json({ task: service.followup(c.req.valid("param").id, input.prompt, input.images, input.model, input.effort, input.permission) }, 202);
    })
    .post("/:id/steer", params(IdParamsSchema), attachmentBody(SteerSchema), (c) => {
      const input = c.req.valid("json");
      return c.json(service.steer(c.req.valid("param").id, input.text, input.images, input.model, input.effort, input.permission), 200);
    })
    .post("/:id/approve", params(IdParamsSchema), jsonBody(ApproveSchema), async (c) => {
      const input = c.req.valid("json");
      return c.json({ task: await service.approve(c.req.valid("param").id, input.decision, input.scope) }, 200);
    })
    .post("/:id/answer", params(IdParamsSchema), jsonBody(AnswerSchema), async (c) => c.json({ task: await service.answer(c.req.valid("param").id, c.req.valid("json")) }, 200))
    .post("/:id/stop", params(IdParamsSchema), jsonBody(EmptyBodySchema), async (c) => c.json({ task: await service.stop(c.req.valid("param").id) }, 200))
    .post("/:id/cancel", params(IdParamsSchema), jsonBody(EmptyBodySchema), async (c) => c.json({ task: await service.cancel(c.req.valid("param").id) }, 200));
}
