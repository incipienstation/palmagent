import { SelectedSkillsSchema } from "./skills.js";
import { z } from "zod";
import { AnswerSchema, ImageAttachmentSchema } from "./requests.js";

export const EXECUTION_PROTOCOL = 1;
export const ExecutionIdSchema = z.string().uuid();
export const ExecutionStartSchema = z.object({
  taskId: z.string().min(1), agent: z.enum(["claude", "codex"]),
  cwd: z.string().min(1), prompt: z.string(), resumeId: z.string().optional(),
  providerHome: z.string().optional(), permission: z.string().optional(),
  model: z.string().optional(), effort: z.string().optional(),
  images: z.array(ImageAttachmentSchema).optional(), messageId: z.string().optional(),
  interactive: z.boolean().optional(),
}).strict();
export type ExecutionStart = z.infer<typeof ExecutionStartSchema>;
export const ExecutionCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("send"), skills: SelectedSkillsSchema, text: z.string(), images: z.array(ImageAttachmentSchema).optional(), messageId: z.string() }),
  z.object({ kind: z.literal("steer"), text: z.string(), images: z.array(ImageAttachmentSchema).optional() }),
  z.object({ kind: z.literal("answer"), answer: AnswerSchema }),
  z.object({ kind: z.literal("approve"), decision: z.string(), scope: z.string().optional() }),
  z.object({ kind: z.literal("interrupt") }),
  z.object({ kind: z.literal("cancel") }),
]);
export type ExecutionCommand = z.infer<typeof ExecutionCommandSchema>;
export type ExecutionCommandResult = "accepted" | "delivered" | "rejected" | "unknown";
