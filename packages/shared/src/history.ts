import type { AgentEvent } from "./events.js";

const TOOL_CALL_SUMMARY_FIELDS = ["id", "tool_use_id", "name", "status", "is_error", "exit_code"] as const;
const TOOL_RESULT_SUMMARY_FIELDS = ["id", "tool_use_id", "status", "is_error", "exit_code"] as const;

/** Keep the fields needed for a collapsed Activity row and defer its full payload. */
export function deferActivityEventDetails(event: AgentEvent): { event: AgentEvent; detailsDeferred: boolean } {
  const fields = event.kind === "tool_call" ? TOOL_CALL_SUMMARY_FIELDS
    : event.kind === "tool_result" ? TOOL_RESULT_SUMMARY_FIELDS : undefined;
  if (!fields) return { event, detailsDeferred: false };

  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown> : {};
  const summary = Object.fromEntries(fields.flatMap((field) => field in payload ? [[field, payload[field]]] : []));
  return { event: { ...event, payload: summary }, detailsDeferred: true };
}
