import { z } from "zod";
import type { TaskActivityDetailsResponse } from "./protocol.js";

const cursor = z.number().int().nonnegative();
/** Tool payloads are provider-owned JSON, including primitive and null historical payloads. */
export const TaskActivityDetailsResponseSchema: z.ZodType<TaskActivityDetailsResponse> = z.object({
  events: z.array(z.object({ seq: cursor, event: z.object({
    taskId: z.string(), agent: z.enum(["claude", "codex"]), kind: z.enum(["tool_call", "tool_result"]),
    sessionId: z.string().optional(), payload: z.unknown(), ts: z.number(),
  }) })),
  from: cursor, through: cursor, cursor,
});
