import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk/core";
import type { RawEvent, StartArgs } from "../../domain/execution.js";

/** The retained host and legacy runner socket present the same Task history. */
export function claudeOutput(args: StartArgs) {
  let messageId: string | undefined;
  let manualBoundary = false;
  const compacting = args.operation === "compact";
  return (ev: SDKMessage, sessionId: string | undefined, emit: (event: RawEvent) => void) => {
    const { taskId } = args;
    if (compacting && ev.type !== "system" && ev.type !== "result") return;
    switch (ev.type) {
      case "system":
        if (ev.subtype === "compact_boundary" && ev.compact_metadata?.trigger === "manual") manualBoundary = true;
        emit({ taskId, sessionId, kind: "status", payload: { subtype: ev.subtype,
          ...(ev.subtype === "init" ? { model: ev.model, cwd: ev.cwd, tools: ev.tools?.length } : {}) } });
        break;
      case "rate_limit_event":
        emit({ taskId, sessionId, kind: "status", payload: { subtype: "rate_limit", info: ev } });
        break;
      case "stream_event": {
        const inner = ev.event;
        if (inner?.type === "message_start") messageId = inner.message?.id;
        if (inner?.type === "message_delta" && messageId) {
          const reason = inner.delta?.stop_reason;
          const phase = reason === "tool_use" ? "progress" : reason === "end_turn" ? "final" : undefined;
          if (phase) emit({ taskId, sessionId, kind: "status", payload: { subtype: "assistant_message", messageId, phase } });
        }
        if (inner?.type === "message_stop") messageId = undefined;
        if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta") {
          emit({ taskId, sessionId, kind: "assistant_text", payload: { text: inner.delta.text, ...(messageId ? { messageId } : {}) } });
        }
        break;
      }
      case "assistant":
        for (const block of ev.message?.content ?? []) {
          if (block.type === "tool_use") emit({ taskId, sessionId, kind: "tool_call",
            payload: { id: block.id, name: block.name, input: block.input } });
        }
        break;
      case "user":
        if (!Array.isArray(ev.message?.content)) break;
        for (const block of ev.message.content) {
          if (block.type === "tool_result") emit({ taskId, sessionId, kind: "tool_result",
            payload: { tool_use_id: block.tool_use_id, content: block.content, is_error: block.is_error } });
        }
        break;
      case "result": {
        const result = "result" in ev ? ev.result : undefined;
        const compactFailed = compacting && (!manualBoundary || ev.is_error || ev.subtype !== "success");
        if (compactFailed) emit({ taskId, sessionId, kind: "error", payload: {
          message: /not enough messages/i.test(result ?? "") ? "Not enough messages to compact." :
            ev.is_error && result ? result : "Claude did not confirm compaction.",
        } });
        emit({ taskId, sessionId, kind: "result", payload: { subtype: ev.subtype, is_error: compactFailed || ev.is_error,
          result, num_turns: ev.num_turns, duration_ms: ev.duration_ms, total_cost_usd: ev.total_cost_usd } });
        break;
      }
    }
  };
}
