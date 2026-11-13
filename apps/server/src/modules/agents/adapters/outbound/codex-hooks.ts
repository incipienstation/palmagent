import { AGENT_HOOK_STOPPED } from "@palmagent/shared";

/** A blocked Stop hook requests continuation; only stopped terminates the turn.
 * Ordinary failed hooks are fail-open in Codex and must not poison later success.
 */
export function codexHookStop(params: Record<string, any>) {
  const run = params.run;
  if (run?.status !== "stopped" || typeof params.turnId !== "string" || typeof run.id !== "string") return;
  const entries: Array<{ kind?: unknown; text?: unknown } | null> = Array.isArray(run.entries) ? run.entries : [];
  const reason = entries.find(entry => entry?.kind === "stop" && typeof entry.text === "string")
    ?? entries.find(entry => entry?.kind === "warning" && typeof entry.text === "string");
  return { code: AGENT_HOOK_STOPPED, turnId: params.turnId as string, hookId: run.id as string,
    message: typeof reason?.text === "string" && reason.text ? reason.text : "A Codex lifecycle hook stopped this turn." };
}
