import type { AgentEvent } from "@palmagent/shared";

// Turn a non-assistant AgentEvent into a detail string. Deliberately
// agent-agnostic: it reads whichever normalized payload fields are present
// (Claude and Codex fill different ones) rather than branching on agent kind.
//
// By default the per-field caps keep it to a scannable one-liner. Pass
// `{ full: true }` to lift every cap and return the whole, untruncated detail —
// what the event log shows when a machinery row is expanded (output mode).
export function describeEvent(ev: AgentEvent, opts?: { full?: boolean }): string {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const full = opts?.full ?? false;
  const cut = (v: string, n: number) => (full || v.length <= n ? v : v.slice(0, n) + "…");

  switch (ev.kind) {
    case "status": {
      const parts = [s(p.subtype)];
      if (p.code !== undefined) parts.push(`code=${String(p.code)}`);
      if (p.model) parts.push(s(p.model));
      if (typeof p.images === "number" && p.images > 0) parts.push(`[${p.images} image${p.images > 1 ? "s" : ""}]`);
      if (p.text) parts.push(cut(s(p.text), 240));
      return parts.filter(Boolean).join(" ");
    }
    case "tool_call": {
      const name = s(p.name) || "tool";
      const cmd = p.command;
      const command = Array.isArray(cmd) ? cmd.join(" ") : s(cmd);
      if (command) return `${name} $ ${cut(command, 240)}`;
      if (p.input !== undefined) return `${name} ${cut(JSON.stringify(p.input), 240)}`;
      if (p.changes !== undefined) return `${name} ${cut(JSON.stringify(p.changes), 240)}`;
      return name;
    }
    case "tool_result": {
      if (typeof p.output === "string") return cut(p.output, 400);
      if (p.content !== undefined) return cut(stringify(p.content), 400);
      return cut(stringify(p), 400);
    }
    case "result": {
      const parts: string[] = [];
      if (p.subtype) parts.push(s(p.subtype));
      if (p.is_error) parts.push("ERROR");
      if (p.result) parts.push(cut(s(p.result), 200));
      if (p.num_turns !== undefined) parts.push(`turns=${String(p.num_turns)}`);
      if (p.usage !== undefined) parts.push(`usage=${cut(JSON.stringify(p.usage), 160)}`);
      return parts.join(" ") || "turn complete";
    }
    case "approval_request":
      return cut(stringify(p), 300);
    case "question": {
      const qs = Array.isArray(p.questions) ? (p.questions as { question?: unknown }[]) : [];
      return qs.map((q) => s(q.question)).filter(Boolean).join(" | ") || "the agent is asking a question";
    }
    case "error":
      return cut(s(p.message) || s(p.error) || stringify(p), 400);
    default:
      return cut(stringify(p), 300);
  }
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
