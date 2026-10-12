import { TURN_RESULT_MISSING } from "./events.js";
import type { AgentEvent, AgentEventKind, AgentKind, AssistantPhase, AssistantTextPayload } from "./events.js";
export type OutputMode = "compact" | "verbose";
export type LogItem =
  | { key: number; endSeq?: number; kind: "assistant_text"; agent: AgentKind; text: string; messageId?: string; phase?: AssistantTextPayload["phase"] }
  | { key: number; endSeq?: number; kind: Exclude<AgentEventKind, "assistant_text">; event: AgentEvent; detailsDeferred?: boolean };

export function appendHistoryEvent(items: LogItem[], event: AgentEvent, seq: number, detailsDeferred = false): void {
  if (event.kind === "assistant_text") {
    const payload = event.payload ?? { text: "" };
    const text = typeof payload.text === "string" ? payload.text : "";
    const messageId = typeof payload.messageId === "string" ? payload.messageId : undefined;
    const phase = payload.phase === "progress" || payload.phase === "partial" || payload.phase === "final" ? payload.phase : undefined;
    const last = items.at(-1);
    if (last?.kind === "assistant_text" && last.agent === event.agent && last.messageId === messageId && last.phase === phase) {
      items[items.length - 1] = { ...last, endSeq: seq, text: last.text + text };
    } else items.push({ key: seq, endSeq: seq, kind: "assistant_text", agent: event.agent, text, messageId, phase });
  } else items.push({ key: seq, endSeq: seq, kind: event.kind, event, ...(detailsDeferred ? { detailsDeferred: true } : {}) });
}

export const CONVERSATION_PAGE_ITEMS = 30;
export const CONVERSATION_PAGE_BYTES = 256 * 1024;
export const CONVERSATION_ITEM_BYTES = 48 * 1024;
export const CONVERSATION_DETAIL_ITEMS = 50;
export interface ConversationContentRef { key: number; version: string; member?: number; label: string }
export type ConversationItem = TranscriptRow & { endSeq: number; revision: number; content?: ConversationContentRef };
export type ConversationPatch = { key: number; revision: number; item: ConversationItem | null };
export interface ConversationDetails { items: ConversationItem[]; nextAfter: number | null; cursor: number }
export interface ConversationContent { chunk: string; nextOffset: number | null; version: string }
export type ConversationActivity = "idle" | "working" | "output" | "blocked" | "ended";


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

export type Activity = { type: "activity"; key: number; items: LogItem[]; live: boolean; preview?: string; summary?: { label: string; count: number }; details?: boolean };
export type RunFailure = { type: "failure"; key: number; items: LogItem[]; previous: boolean; completed?: boolean };
export type TranscriptRow = Activity | RunFailure | { type: "message"; key: number; item: LogItem };

export function runInterrupted(failure: RunFailure): boolean {
  return !failure.completed && failure.items.some((item) => item.kind === "result" ||
    (item.kind === "status" && payload(item).subtype === "process_exit") ||
    (item.kind === "error" && payload(item).code === TURN_RESULT_MISSING));
}

// This is a view over the retained stream, never a destructive filter. Explicit
// provider phase markers can arrive after text deltas. Unknown/legacy prose is
// always signal; a later tool call alone is not proof that text was progress.
export function presentTranscript(log: LogItem[], mode: OutputMode, live: boolean): TranscriptRow[] {
  if (mode === "verbose") return log.filter((item) => item.kind !== "status" || payload(item).subtype !== "context_compacted")
    .map((item) => ({ type: "message", key: item.key, item }));
  const rows: TranscriptRow[] = [];
  let turn: LogItem[] = [];
  let failure: RunFailure | undefined;
  const flush = (active: boolean) => {
    if (!turn.length) return;
    const start = rows.length;
    const phases = new Map<string, AssistantPhase>();
    for (const item of turn) {
      const p = payload(item);
      if (p.subtype === "assistant_message" && typeof p.messageId === "string" && (p.phase === "progress" || p.phase === "partial" || p.phase === "final")) {
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
      // Tool failures are work details. Run errors have one disclosure across
      // error/result/process-exit signals, including signals after result flush.
      if (failed(item) && item.kind !== "tool_call" && item.kind !== "tool_result") {
        if (!failure) {
          failure = { type: "failure", key: item.key, items: [], previous: false };
          rows.push(failure);
        }
        failure.items.push(item);
        failure.completed = false;
        continue;
      }
      if (item.kind === "result" && failure) failure.completed = true;
      // Late message classification belongs to the preceding disclosure. Do not
      // move its membership (and open state) when work resumes after an answer.
      if (item.kind === "status" && p.subtype === "assistant_message") {
        const previous = rows.slice(start).reverse().find((row): row is Activity => row.type === "activity");
        previous?.items.push(item);
        continue;
      }
      const machinery = item.kind === "status" || item.kind === "tool_call" || item.kind === "tool_result" || item.kind === "result";
      const background = machinery || phaseOf(item) === "progress";
      if (background) {
        if (!group) {
          group = { type: "activity", key: item.key, items: [], live: false };
          rows.push(group);
        }
        group.items.push(item);
        if (item === latestProgress && active && item.kind === "assistant_text") group.preview = item.text;
      }
      // Visible answers and images separate consecutive work groups. Never move
      // later tools above content the user has already started reading.
      if (!background) {
        group = undefined;
        rows.push({ type: "message", key: item.key, item });
      }
      if (item.kind === "result" && !failed(item) && typeof p.result === "string" && p.result.trim() && !texts.has(p.result.trim())) {
        const answer: LogItem = { key: item.key, kind: "assistant_text", agent: item.event.agent, text: p.result, phase: "final" };
        rows.push({ type: "message", key: item.key, item: answer });
        texts.add(p.result.trim());
      }
    }
    // Lifecycle/result-only bands do not deserve their own row. Retain them in
    // the nearest work disclosure, or in Verbose when a turn contains no work.
    const groups = rows.slice(start).filter((row): row is Activity => row.type === "activity");
    const work = groups.filter((group) => group.items.some((item) =>
      item.kind === "tool_call" || item.kind === "tool_result" || phaseOf(item) === "progress"));
    const keep = new Set(work);
    for (const group of groups) {
      if (keep.has(group)) continue;
      const target = work.find((candidate) => candidate.key > group.key) ?? work.at(-1);
      if (target) target.items = [...target.items, ...group.items].sort((a, b) => a.key - b.key);
    }
    // Keep the earliest member sequence as the React/Virtuoso key so streaming
    // classification never remounts the disclosure and flashes its content.
    for (const group of groups) {
      if (!keep.has(group)) continue;
      group.key = group.items.reduce((key, item) => Math.min(key, item.key), group.key);
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
    if (item.kind === "status" && p.subtype === "context_compacted") { flush(false); continue; }
    // Answers and steering continue the same run; only a new request or a
    // provider turn start makes the previous run's error historical.
    if (item.kind === "status" && ["dispatch", "followup", "turn_started"].includes(String(p.subtype))) {
      flush(false);
      if (failure) failure.previous = true;
      failure = undefined;
    }
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
  if (group.summary) return group.summary.label;
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
  return `${label} · ${count}${failures.size ? ` · ${failures.size} failed` : ""}`;
}
