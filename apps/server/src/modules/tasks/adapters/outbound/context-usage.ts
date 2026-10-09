import type { AgentEvent, ContextUsage } from "@palmagent/shared";

/** Decode the persisted Codex usage event; never sum calls or subtract cached input. */
export function projectContextUsage(previous: ContextUsage | undefined, event: AgentEvent): ContextUsage | undefined {
  if (event.agent !== "codex" || event.kind !== "status") return previous;
  const p = event.payload as { subtype?: string; usage?: { last?: { totalTokens?: unknown }; modelContextWindow?: unknown } };
  if (["compaction_requested", "context_compaction_started"].includes(p?.subtype ?? "")) {
    return previous ? { ...previous, stale: true } : undefined;
  }
  if (p?.subtype !== "usage") return previous;
  const used = p.usage?.last?.totalTokens;
  if (typeof used !== "number" || !Number.isSafeInteger(used) || used < 0) return previous ? { ...previous, stale: true } : undefined;
  const window = p.usage?.modelContextWindow;
  return { usedTokens: used, windowTokens: typeof window === "number" && Number.isSafeInteger(window) && window > 0 ? window : null, updatedAt: event.ts };
}
