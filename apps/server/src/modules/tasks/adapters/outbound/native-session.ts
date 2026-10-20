import { expandHome } from "../../../../platform/filesystem/paths.js";
import { processIdentity } from "../../../../platform/process/identity.js";
export { processIdentity } from "../../../../platform/process/identity.js";
import type { AgentEventKind, AgentEventPayloads } from "@palmagent/shared";
import { createHash } from "node:crypto";
import { readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import type { AgentEvent, AgentKind, SessionControl, TaskState } from "@palmagent/shared";
import { extractOutputImages } from "../../application/attachments/output-images.js";
import { scanTranscript } from "./native-transcript.js";

export const nativeHome = (agent: AgentKind) => resolve(agent === "claude"
  ? (process.env.CLAUDE_CONFIG_DIR ? expandHome(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), ".claude"))
  : process.env.CODEX_HOME ?? join(homedir(), ".codex"));
export const shellQuote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";

export function resumeCommand(task: TaskState, socketDirectory?: string): string {
  if (!task.sessionId || !task.worktreePath || !task.sessionControl) throw new Error("Session is not available for handoff");
  const env = task.agent === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const args = task.agent === "claude" ? ["claude", "--resume", task.sessionId] : ["codex", "resume", task.sessionId, "--cd", task.worktreePath];
  if (task.sessionControl.owner === "shared") args.splice(1, 0, "--remote", `unix://${task.sessionControl.sharedSocket ?? ""}`);
  if (task.model && task.sessionControl.owner !== "shared") args.push("--model", task.model);
  if (task.agent === "claude") {
    if (task.effort) args.push("--effort", task.effort);
  } else if (task.effort && task.sessionControl.owner !== "shared") args.push("-c", `model_reasoning_effort=${task.effort}`);
  const instance = socketDirectory ? `PALMAGENT_SESSION_SOCKET_DIR=${shellQuote(socketDirectory)} ` : "";
  return `cd ${shellQuote(task.worktreePath)} && ${instance}${env}=${shellQuote(task.sessionControl.home)} ${args.map(shellQuote).join(" ")}`;
}

export function locateSession(agent: AgentKind, sessionId: string, cwd: string, home: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{7,127}$/.test(sessionId)) throw new Error("Invalid native session id");
  const root = realpathSync(home);
  const candidates: string[] = [];
  if (agent === "claude") candidates.push(join(root, "projects", resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`));
  else {
    let visited = 0;
    const walk = (path: string, depth: number) => {
      if (depth > 4) return;
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (++visited > 100_000) throw new Error("Session index is too large; narrow the provider home");
        if (entry.isDirectory()) walk(join(path, entry.name), depth + 1);
        else if (entry.isFile() && entry.name.endsWith(`-${sessionId}.jsonl`)) candidates.push(join(path, entry.name));
      }
    };
    walk(join(root, "sessions"), 0);
  }
  if (candidates.length !== 1) throw new Error("Native transcript was not found uniquely in this provider home");
  const path = realpathSync(candidates[0]);
  if (relative(root, path).startsWith("..")) throw new Error("Native transcript escapes its provider home");
  return path;
}

export function checkpointSession(task: TaskState): SessionControl {
  const home = task.sessionControl?.home ?? nativeHome(task.agent);
  const transcript = locateSession(task.agent, task.sessionId!, task.worktreePath!, home);
  const checkpoint = scanTranscript(transcript, task, undefined, false, () => {});
  return { owner: "local", home, transcript, ...checkpoint };
}

export function synchronizeSession(task: TaskState, { preview = false } = {}): { control: SessionControl; events: AgentEvent[] } {
  const control = task.sessionControl!;
  const expected = locateSession(task.agent, task.sessionId!, task.worktreePath!, control.home);
  if (expected !== control.transcript) throw new Error("Native transcript location changed");
  const events: AgentEvent[] = [];
  const checkpoint = scanTranscript(expected, task, control, preview, (row) => {
    const ts = Number.isFinite(Date.parse(row.timestamp)) ? Date.parse(row.timestamp) : Date.now();
    const emit = <K extends AgentEventKind>(kind: K, payload: AgentEventPayloads[K]) => events.push({ taskId: task.taskId, agent: task.agent, sessionId: task.sessionId, kind, payload, ts } as AgentEvent);
    if (task.agent === "codex" && row.type === "event_msg" && row.payload?.type === "token_count" && row.payload.info) {
      const info = row.payload.info;
      emit("status", { subtype: "usage", usage: { last: { totalTokens: info.last_token_usage?.total_tokens }, modelContextWindow: info.model_context_window } });
    }
    if (task.agent === "codex" && row.type === "compacted") emit("status", { subtype: "context_compaction_started" });
    // Codex response_item is canonical; event_msg repeats the same prose.
    if (task.agent === "codex" && row.type === "response_item") {
      const item = row.payload;
      if (["function_call", "custom_tool_call"].includes(item?.type)) {
        emit("tool_call", { name: item.name, input: item.arguments ?? item.input, id: item.call_id });
        return;
      }
      if (["function_call_output", "custom_tool_call_output"].includes(item?.type)) {
        const output = extractOutputImages(item.output);
        emit("tool_result", { content: output.payload, tool_use_id: item.call_id });
        for (const img of output.images) emit("output_image", { ...img, tool_use_id: item.call_id });
        return;
      }
    }
    const message = task.agent === "codex" ? row.type === "response_item" && row.payload?.type === "message" ? row.payload : undefined
      : row.type === "user" || row.type === "assistant" ? row.message : undefined;
    if (!message || !["user", "assistant"].includes(message.role)) return;
    const content = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
    const text = content.filter((b: Record<string, any>) => ["text", "input_text", "output_text"].includes(b.type) && typeof b.text === "string").map((b: Record<string, any>) => b.text).join("\n");
    if (text && message.role === "user") emit("status", { subtype: "followup", text, source: "local" });
    if (text && message.role === "assistant") {
      const phase = task.agent === "codex"
        ? message.phase === "commentary" ? "progress" : message.phase === "partial_answer" ? "partial" : message.phase === "final_answer" ? "final" : undefined
        : message.stop_reason === "tool_use" ? "progress" : message.stop_reason === "end_turn" ? "final" : undefined;
      emit("assistant_text", { text, ...(typeof message.id === "string" ? { messageId: message.id } : {}), ...(phase ? { phase } : {}) });
    }
    let imageCount = 0;
    for (const source of content) {
      const output = extractOutputImages(source);
      const block = output.payload as Record<string, any>;
      if (block.type === "tool_use") emit("tool_call", { name: block.name, input: block.input, id: block.id });
      if (block.type === "tool_result") emit("tool_result", { content: block.content, tool_use_id: block.tool_use_id, is_error: block.is_error });
      for (const img of output.images.slice(0, 4 - imageCount)) {
        imageCount++;
        emit("output_image", { ...img,
          ...(block.type === "tool_result" ? { tool_use_id: block.tool_use_id } : block.type === "tool_use" ? { tool_use_id: block.id }
            : { source: "message" as const }) });
      }
    }
  });
  if (preview && checkpoint.cursor === 0) return { control, events };
  const next: SessionControl = { ...control, ...checkpoint, error: undefined };
  if (!preview) { next.owner = "palmagent"; delete next.waitPid; delete next.waitIdentity; }
  return { control: next, events };
}
export const emptyTranscriptHash = createHash("sha256").digest("hex");
