import { z } from "zod";
import type { ConversationItem } from "./conversation.js";
import type { TaskHistoryResponse, TaskHistoryChangesResponse } from "./protocol.js";

const cursor = z.number().int().nonnegative();
const activity = z.enum(["idle", "working", "output", "blocked", "ended"]);
// Validate the native read envelope without transforming the versioned projection's
// provider-owned nested fields. The TypeScript projection writer owns their semantics.
const item = z.custom<ConversationItem>(value => {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return ["message", "activity", "failure"].includes(String(row.type))
    && [row.key, row.endSeq, row.revision].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0);
});
export const TranscriptPageSchema: z.ZodType<TaskHistoryResponse> = z.object({
  events: z.array(z.never()).length(0), transcript: z.array(item), before: cursor.nullable(), cursor, activity,
});
export const TranscriptChangesSchema: z.ZodType<TaskHistoryChangesResponse> = z.object({
  events: z.array(z.never()).length(0), transcript: z.array(z.object({ key: cursor, revision: cursor, item: item.nullable() })),
  after: cursor, through: cursor, nextAfter: cursor.nullable(), nextKey: cursor.optional(), activity: activity.optional(),
});
