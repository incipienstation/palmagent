import { z } from "zod";

export const SideChatSendSchema = z.object({
  sessionId: z.string().uuid(),
  messageId: z.string().uuid(),
  text: z.string().trim().min(1).max(16_000),
}).strict();
export const SideChatSessionSchema = z.object({ sessionId: z.string().uuid() }).strict();
export type SideChatSend = z.infer<typeof SideChatSendSchema>;
export interface SideChatMessage { id: string; role: "user" | "assistant"; text: string }
export interface SideChatSnapshot {
  id: string;
  status: "starting" | "idle" | "running" | "ended";
  messages: SideChatMessage[];
  revision: number;
  completed: number;
  error?: string;
}
