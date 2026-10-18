import type { AgentKind } from "./events.js";
import { failed, payload, presentTranscript, type Activity, type LogItem, type TranscriptRow } from "./conversation.js";

export type TraceState = "running" | "completed" | "error" | "interrupted" | "unknown";
export type TraceKind = "tool" | "reasoning" | "progress" | "event";
export interface TraceStep {
  key: number;
  title: string;
  kind: TraceKind;
  state: TraceState;
  description?: string;
}
/** Retained only in the projection, never sent with the collapsed conversation. */
export interface TraceOperation extends TraceStep { members: number[] }
export interface ConversationSteps { steps: TraceStep[]; nextAfter: number | null; cursor: number }

const text = (value: unknown) => typeof value === "string" ? value : "";
const short = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 160);

/** Only bounded, descriptive input fields belong in the summary projection. */
export function toolSummary(payload: Record<string, unknown>): string {
  if (typeof payload.traceTitle === "string") return short(payload.traceTitle);
  const input = payload.input && typeof payload.input === "object" ? payload.input as Record<string, unknown> : {};
  const command = payload.command ?? input.command;
  if (typeof command === "string") return short(command);
  if (Array.isArray(command)) return short(command.filter(part => typeof part === "string").join(" "));
  const path = text(input.file_path) || text(input.path);
  if (path) return short(`${text(payload.name) || "File"} ${path}`);
  return short(text(payload.name) || "Tool");
}

const boundary = (item: LogItem) => item.kind === "status" &&
  ["dispatch", "followup", "turn_started"].includes(text(payload(item).subtype));
const terminal = (item: LogItem) => item.kind === "result" || item.kind === "error" ||
  item.kind === "status" && ["process_exit", "stop", "error"].includes(text(payload(item).subtype));

/** Calls correlate only inside one task/run/provider/session. Missing IDs never correlate by position. */
export function traceOperations(log: LogItem[], live: boolean): TraceOperation[] {
  const operations: TraceOperation[] = [];
  let calls = new Map<string, TraceOperation>();
  let active: TraceOperation[] = [];
  const finish = (interrupted: boolean) => {
    for (const operation of active) if (operation.state === "running") operation.state = interrupted ? "interrupted" : "unknown";
    active = []; calls = new Map();
  };
  for (const item of log) {
    const p = payload(item);
    if (boundary(item)) finish(false);
    if (terminal(item)) { finish(failed(item) || item.kind !== "result"); continue; }
    if (item.kind === "tool_call" || item.kind === "tool_result") {
      const id = text(p.tool_use_id) || text(p.id);
      const key = id ? JSON.stringify([item.event.taskId, item.event.agent, item.event.sessionId ?? "", id]) : undefined;
      let operation = key ? calls.get(key) : undefined;
      if (!operation) {
        operation = { key: item.key, kind: item.kind === "tool_call" ? "tool" : "event", title: item.kind === "tool_call" ? toolSummary(p) : "Tool result",
          state: "running", members: [] };
        operations.push(operation); active.push(operation);
        if (key) calls.set(key, operation);
      }
      operation.members.push(item.key);
      if (item.kind === "tool_call") { operation.kind = "tool"; operation.title = toolSummary(p); }
      const state = text(p.status);
      if (failed(item)) operation.state = "error";
      else if (["interrupted", "cancelled", "canceled"].includes(state)) operation.state = "interrupted";
      else if (["completed", "success", "succeeded"].includes(state) ||
        item.kind === "tool_result" && !["in_progress", "running", "pending"].includes(state)) operation.state = "completed";
      else if (operation.state !== "error" && operation.state !== "completed") operation.state = "running";
    } else if (item.kind === "assistant_text") {
      // The transcript, including late phase markers, decides which prose belongs in Activity.
      operations.push({ key: item.key, kind: "progress", title: short(item.text) || "Progress update",
        state: "completed", members: [item.key] });
    } else if (item.kind === "status" && p.subtype === "reasoning") {
      operations.push({ key: item.key, kind: "reasoning", title: "Reasoning", state: "completed", members: [item.key] });
    } else if (item.kind === "status" && !["init", "session_started", "turn_started", "dispatch", "followup", "steer", "answer",
      "assistant_message", "message_delivered", "usage", "context_usage", "context_compacted"].includes(text(p.subtype))) {
      operations.push({ key: item.key, kind: "event", title: short(text(p.subtype).replaceAll("_", " ")) || "Status update",
        state: failed(item) ? "error" : "completed", members: [item.key] });
    }
  }
  if (!live) finish(false);
  return operations;
}

/** Attach operations to their first visible Activity, even when a result follows a reply. */
export function attachTraceOperations(rows: TranscriptRow[], log: LogItem[], live: boolean): void {
  const owners = new Map<number, Activity>();
  for (const row of rows) if (row.type === "activity") {
    row.operations = [];
    for (const item of row.items) owners.set(item.key, row);
  }
  for (const operation of traceOperations(log, live)) {
    const owner = operation.members.map(key => owners.get(key)).find(Boolean);
    if (owner) owner.operations!.push(operation);
  }
}

export function projectConversation(log: LogItem[], live: boolean): TranscriptRow[] {
  const rows = presentTranscript(log, "compact", live);
  attachTraceOperations(rows, log, live);
  return rows.filter(row => row.type !== "activity" || !!row.operations?.length);
}

export function traceStepTitle(step: TraceStep): string {
  const prefix: Record<TraceState, string> = { running: "Running", completed: "Completed", error: "Failed", interrupted: "Interrupted", unknown: "Result unavailable" };
  return step.kind === "tool" || step.state === "error" || step.state === "interrupted" ? `${prefix[step.state]}: ${step.title}` : step.title;
}

export interface ExecutionRecord {
  key: number; kind: string; agent: AgentKind; ts: number;
  body?: string;
  version: string;
}
export interface ExecutionRecords { records: ExecutionRecord[]; before: number | null; cursor: number }
