import { TURN_RESULT_MISSING, type AgentEvent } from "./events.js";

// Historical data vocabulary belongs at migration boundaries, never in renderers.
export const LEGACY_TURN_RESULT_MISSING_MESSAGE = "Codex exited before a terminal turn result.";

export function migrateLegacyEvent(event: AgentEvent): AgentEvent {
  if (event.agent !== "codex" || event.kind !== "error") return event;
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || "code" in payload ||
      !("message" in payload) || payload.message !== LEGACY_TURN_RESULT_MISSING_MESSAGE) return event;
  return { ...event, payload: { ...payload, code: TURN_RESULT_MISSING } };
}
