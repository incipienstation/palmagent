import type { PendingMessage } from "./messages.js";
import type { LogItem } from "./conversation.js";
import { payload, userMessage, traceImage } from "./conversation.js";

export type TranscriptActivity = "idle" | "working" | "output" | "blocked" | "ended";

// Replay semantic transitions, not the last event kind or a silence timeout.
// Usage, late phase markers and other metadata must not restart a waiting label.
export function transcriptActivity(log: LogItem[], { running, loading = false, blocked = false, messages = [], projected }: {
  projected?: TranscriptActivity; running: boolean; loading?: boolean; blocked?: boolean; messages?: PendingMessage[];
}): TranscriptActivity {
  let state: TranscriptActivity = "working";
  const acknowledged = new Set<string>();
  for (const item of log) {
    const p = payload(item);
    const subtype = item.kind === "status" ? p.subtype : undefined;
    if ((userMessage(item) || subtype === "message_delivered") && typeof p.messageId === "string") acknowledged.add(p.messageId);
    if (["dispatch", "followup", "turn_started"].includes(String(subtype))) {
      state = "working";
    } else if (item.kind === "result" || item.kind === "error" || subtype === "process_exit" || subtype === "stop" || subtype === "error") {
      state = "ended";
    } else if (state !== "ended") {
      if (item.kind === "question" || item.kind === "approval_request") state = "blocked";
      else if (["answer", "approval", "input_resolved"].includes(String(subtype))) {
        if (state === "blocked") state = "working";
      } else if (state !== "blocked") {
        if ((item.kind === "assistant_text" && item.text.trim()) || item.kind === "output_image" && !traceImage(item)) state = "output";
        else if (item.kind === "tool_call" || item.kind === "tool_result" || traceImage(item) || subtype === "reasoning" || subtype === "steer") state = "working";
      }
    }
  }
  if (projected) state = projected;
  if (blocked) return "blocked";
  const sending = messages.filter(message => message.status === "sending");
  // A new optimistic send belongs after the retained turn. Once acknowledged,
  // its stale HTTP receipt must not override newer output or terminal events.
  if (sending.some(message => !acknowledged.has(message.id))) return "working";
  if (loading || (!running && !sending.length)) return "idle";
  return state;
}
