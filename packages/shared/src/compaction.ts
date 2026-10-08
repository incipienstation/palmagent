import { z } from "zod";
import type { TaskState } from "./task.js";

export const CompactTaskSchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
}).strict();
export type CompactTaskRequest = z.infer<typeof CompactTaskSchema>;

export interface ContextCompaction {
  requestId: string;
  status: "running" | "completed" | "failed";
  error?: string;
}

/** The same admission explanation is used by the menu and the server. */
export function compactUnavailableReason(task: TaskState): string | undefined {
  if (task.agent !== "codex") return "Context compaction is available only for Codex.";
  if (task.sessionControl && task.sessionControl.owner !== "palmagent") return "Continue this session in Palmagent first.";
  if (task.messageQueue?.compaction?.status === "running") return "Context compaction is in progress.";
  if (task.status === "archived" || task.status === "cancelled") return "This task is closed.";
  if (!task.sessionId) return "Available after the first response.";
  if (!task.worktreePath) return "The session directory is unavailable.";
  if (!["idle", "failed"].includes(task.status) || task.messageQueue?.runId) return "Available after the response finishes.";
  if (task.messageQueue?.messages.some(message => !["delivered", "cancelled"].includes(message.status))) return "Resolve queued messages first.";
}
