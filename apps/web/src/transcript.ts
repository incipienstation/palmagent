import type { AssistantPhase } from "@palmagent/shared";
import type { LogItem } from "./hooks/useTaskStream";
import type { OutputMode } from "./OutputModeProvider";

export function payload(item: LogItem): Record<string, unknown> {
  if (item.kind === "assistant_text") return {};
  const value = item.event.payload;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function failed(item: LogItem): boolean {
  const p = payload(item);
  return item.kind === "error" || p.is_error === true || p.status === "failed" ||
    (typeof p.exit_code === "number" && p.exit_code !== 0) ||
    (item.kind === "status" && p.subtype === "process_exit" && typeof p.code === "number" && p.code !== 0) ||
    (item.kind === "result" && typeof p.subtype === "string" && p.subtype.startsWith("error"));
}

export function userMessage(item: LogItem): boolean {
  return item.kind === "status" && ["dispatch", "followup", "steer", "answer"].includes(String(payload(item).subtype));
}

export type Activity = { type: "activity"; key: number; items: LogItem[]; live: boolean; preview?: string };
export type TranscriptRow = Activity | { type: "message"; key: number; item: LogItem };

// This is a view over the retained stream, never a destructive filter. Explicit
// provider phase markers can arrive after text deltas. Unknown/legacy prose is
// always signal; a later tool call alone is not proof that text was progress.
export function presentTranscript(log: LogItem[], mode: OutputMode, live: boolean): TranscriptRow[] {
  if (mode === "verbose") return log.map((item) => ({ type: "message", key: item.key, item }));
  const rows: TranscriptRow[] = [];
  let turn: LogItem[] = [];
  const flush = (active: boolean) => {
    if (!turn.length) return;
    const start = rows.length;
    const phases = new Map<string, AssistantPhase>();
    for (const item of turn) {
      const p = payload(item);
      if (p.subtype === "assistant_message" && typeof p.messageId === "string" && (p.phase === "progress" || p.phase === "final")) {
        phases.set(p.messageId, p.phase);
      }
    }
    const phaseOf = (item: LogItem) => item.kind === "assistant_text"
      ? item.phase ?? (item.messageId ? phases.get(item.messageId) : undefined) : undefined;
    const latestProgress = turn.filter((item) => phaseOf(item) === "progress").at(-1);
    let group: Activity | undefined;
    const texts = new Set(turn.flatMap((item) => item.kind === "assistant_text" && phaseOf(item) !== "progress" ? [item.text.trim()] : []));
    for (const item of turn) {
      const p = payload(item);
      const machinery = item.kind === "status" || item.kind === "tool_call" || item.kind === "tool_result" || item.kind === "result";
      const background = machinery || phaseOf(item) === "progress";
      if (background) {
        if (!group) {
          group = { type: "activity", key: item.key, items: [], live: false };
          rows.push(group);
        }
        group.items.push(item);
        if (item === latestProgress && (active || mode === "default") && item.kind === "assistant_text") group.preview = item.text;
      }
      // Failure summaries remain visible even with activity collapsed. The raw
      // output is also retained inside the disclosure for diagnosis.
      if (failed(item) || !background) {
        rows.push({ type: "message", key: item.key, item });
        if (mode === "default") group = undefined;
      }
      if (item.kind === "result" && !failed(item) && typeof p.result === "string" && p.result.trim() && !texts.has(p.result.trim())) {
        const answer: LogItem = { key: item.key, kind: "assistant_text", agent: item.event.agent, text: p.result, phase: "final" };
        rows.push({ type: "message", key: item.key, item: answer });
        texts.add(p.result.trim());
        if (mode === "default") group = undefined;
      }
    }
    // Lifecycle/result-only bands do not deserve their own row. Retain them in
    // the nearest work disclosure, or in Verbose when a turn contains no work.
    const groups = rows.slice(start).filter((row): row is Activity => row.type === "activity");
    const work = groups.filter((group) => group.items.some((item) =>
      item.kind === "tool_call" || item.kind === "tool_result" || phaseOf(item) === "progress"));
    const keep = new Set(work);
    if (!work.length && active && groups.length) keep.add(groups.at(-1)!);
    for (const group of groups) {
      if (keep.has(group)) continue;
      const target = work.find((candidate) => candidate.key > group.key) ?? work.at(-1);
      if (target) target.items = [...target.items, ...group.items].sort((a, b) => a.key - b.key);
    }
    const visible = rows.slice(start).filter((row) => row.type !== "activity" || keep.has(row));
    rows.splice(start, rows.length - start, ...visible);
    if (active) {
      const last = visible.filter((row): row is Activity => row.type === "activity").at(-1);
      if (last) last.live = true;
    }
    turn = [];
  };
  for (const item of log) {
    const p = payload(item);
    if (userMessage(item) || item.kind === "question" || item.kind === "approval_request") {
      flush(false);
      rows.push({ type: "message", key: item.key, item });
    } else {
      if (item.kind === "status" && p.subtype === "turn_started") flush(false);
      turn.push(item);
      if (item.kind === "result") flush(false);
    }
  }
  flush(live);
  return rows;
}

export function activityLabel(group: Activity, mode: OutputMode): string {
  const tools = new Map<string | number, string>();
  const failures = new Set<string | number>();
  for (const item of group.items) {
    const p = payload(item);
    if (item.kind === "tool_call") tools.set(typeof p.id === "string" ? p.id : item.key, String(p.name ?? "tool"));
    if (failed(item)) failures.add(typeof p.id === "string" ? p.id : typeof p.tool_use_id === "string" ? p.tool_use_id : item.key);
  }
  const names = [...tools.values()];
  const category = names.length && names.every((name) => /^(bash|Bash|command_execution)$/.test(name)) ? "Commands"
    : names.length && names.every((name) => /^(read|Read|Glob|Grep)$/.test(name)) ? "File checks"
    : names.length && names.every((name) => /^(write|Write|Edit|file_change)$/.test(name)) ? "File changes"
    : "Activity";
  const label = mode === "compact" ? "Activity" : category;
  const count = tools.size ? `${tools.size} ${tools.size === 1 ? "tool" : "tools"}` : `${group.items.length} ${group.items.length === 1 ? "event" : "events"}`;
  const state = group.live ? mode === "compact" ? "Working…" : category === "Commands" ? "Running commands…" : "Working…" : label;
  return `${failures.size ? `${failures.size} failed · ` : ""}${state} · ${count}`;
}
