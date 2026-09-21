import { SelectedSkillsSchema } from "./skills.js";
import { z } from "zod";
import { ImageAttachmentSchema } from "./requests.js";

export const MessageSettingsSchema = z.object({ model: z.string().optional(), effort: z.string().optional(), permission: z.string().optional() });
export const SubmitMessageSchema = z.object({
  clientMessageId: z.string().uuid(), mode: z.enum(["send", "queue"]),
  text: z.string().trim().min(1).max(100_000), skills: SelectedSkillsSchema, images: z.array(ImageAttachmentSchema).optional(),
  expectedRunId: z.string().nullable(), settings: MessageSettingsSchema.optional(),
});
export const MessageActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("edit"), version: z.number().int(), token: z.string().uuid() }),
  z.object({ action: z.literal("renew"), token: z.string().uuid() }),
  z.object({ action: z.literal("save"), token: z.string().uuid(), version: z.number().int(), text: z.string().trim().min(1).max(100_000), skills: SelectedSkillsSchema, images: z.array(ImageAttachmentSchema).optional() }),
  z.object({ action: z.literal("release"), token: z.string().uuid() }),
  z.object({ action: z.literal("delete"), version: z.number().int() }),
  z.object({ action: z.literal("send"), version: z.number().int(), expectedRunId: z.string().nullable() }),
]);
export type SubmitMessage = z.infer<typeof SubmitMessageSchema>;
export type MessageAction = z.infer<typeof MessageActionSchema>;
export type MessageSettings = z.infer<typeof MessageSettingsSchema>;
export interface PendingMessage {
  id: string;
  version: number;
  mode: "send" | "queue";
  text: string;
  skills?: import("./skills.js").SkillSelection[];
  images?: z.infer<typeof ImageAttachmentSchema>[]; // unsent drafts and legacy queue entries
  attachments?: import("./attachments.js").Attachment[];
  settings?: MessageSettings;
  status: "queued" | "sending" | "delivered" | "rejected" | "unknown" | "cancelled";
  runId?: string;
  error?: string;
  editingUntil?: number;
}
export interface MessageQueue {
  revision: number;
  paused: boolean;
  runId: string | null;
  messages: PendingMessage[];
}
