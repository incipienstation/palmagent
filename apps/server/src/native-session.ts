import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import type { AgentEvent, AgentKind, SessionControl, TaskState } from "@palmagent/shared";
import { config } from "./config.js";
import { extractOutputImages } from "./application/output-images.js";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export const nativeHome = (agent: AgentKind) => resolve(agent === "claude"
  ? config.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")
  : process.env.CODEX_HOME ?? join(homedir(), ".codex"));
export const shellQuote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";

export function resumeCommand(task: TaskState, socketDirectory?: string): string {
  if (!task.sessionId || !task.worktreePath || !task.sessionControl) throw new Error("Session is not available for handoff");
  const env = task.agent === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const args = task.agent === "claude" ? ["claude", "--resume", task.sessionId] : ["codex", "resume", task.sessionId, "--cd", task.worktreePath];
  if (task.model) args.push("--model", task.model);
  if (task.agent === "claude") {
    if (task.effort) args.push("--effort", task.effort);
  } else if (task.effort) args.push("-c", `model_reasoning_effort=${task.effort}`);
  const instance = socketDirectory ? `PALMAGENT_SESSION_SOCKET_DIR=${shellQuote(socketDirectory)} ` : "";
  return `cd ${shellQuote(task.worktreePath)} && ${instance}${env}=${shellQuote(task.sessionControl.home)} ${args.map(shellQuote).join(" ")}`;
}

// Linux process start ticks plus boot identity distinguish a live writer from
// PID reuse. Unknown inspection errors never count as a writer exit.
export function processIdentity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("A valid local CLI process id is required");
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z") return undefined;
    return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${fields[19]}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Cannot verify the local CLI process; ownership is retained");
  }
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

function readTranscript(path: string, preview = false): Buffer {
  if (!statSync(path).isFile() || statSync(path).size > 64 * 1024 * 1024) throw new Error("Native transcript is not a regular file or exceeds 64 MiB");
  const data = readFileSync(path);
  if (data.length > 64 * 1024 * 1024) throw new Error("Native transcript exceeds 64 MiB");
  if (data.length && data[data.length - 1] !== 10) {
    if (preview) return data.subarray(0, data.lastIndexOf(10) + 1);
    throw new Error("Native transcript has an unfinished record; try again after the CLI closes");
  }
  return data;
}

type RecordValue = Record<string, any>;
function records(data: Buffer): RecordValue[] {
  return data.toString("utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as RecordValue);
}
function verifySession(data: Buffer, task: Pick<TaskState, "sessionId" | "agent" | "worktreePath">) {
  let meta: RecordValue | undefined;
  // Identity is near the beginning; avoid reparsing the entire saved history on
  // every preview poll. The prefix hash still verifies all previously read bytes.
  for (let start = 0; start < data.length;) {
    const end = data.indexOf(10, start);
    if (end < 0) break;
    const text = data.subarray(start, end).toString("utf8").trim();
    start = end + 1;
    if (!text) continue;
    const row = JSON.parse(text) as RecordValue;
    meta = task.agent === "codex" ? row.type === "session_meta" ? row.payload : undefined
      : row.sessionId === task.sessionId && row.cwd ? row : undefined;
    if (meta) break;
  }
  if (!meta || (task.agent === "codex" ? meta.id : meta.sessionId) !== task.sessionId || realpathSync(meta.cwd) !== realpathSync(task.worktreePath!)) {
    throw new Error("Native session identity or working directory does not match");
  }
}

export function checkpointSession(task: TaskState): SessionControl {
  const home = task.sessionControl?.home ?? nativeHome(task.agent);
  const transcript = locateSession(task.agent, task.sessionId!, task.worktreePath!, home);
  const data = readTranscript(transcript);
  records(data); // Checkpoint only complete, parseable history before skipping it on return.
  verifySession(data, task);
  return { owner: "local", home, transcript, cursor: data.length, prefixHash: hash(data) };
}

export function synchronizeSession(task: TaskState, { preview = false } = {}): { control: SessionControl; events: AgentEvent[] } {
  const control = task.sessionControl!;
  const expected = locateSession(task.agent, task.sessionId!, task.worktreePath!, control.home);
  if (expected !== control.transcript) throw new Error("Native transcript location changed");
  const data = readTranscript(expected, preview);
  if (data.length < control.cursor || hash(data.subarray(0, control.cursor)) !== control.prefixHash) throw new Error("Native transcript changed before the synchronization cursor");
  const rows = records(data.subarray(control.cursor));
  // An in-progress first record can wait; later polls parse only appended events.
  if (preview && data.length === 0) return { control, events: [] };
  verifySession(data, task);
  const events: AgentEvent[] = [];
  for (const row of rows) {
    const ts = Number.isFinite(Date.parse(row.timestamp)) ? Date.parse(row.timestamp) : Date.now();
    const emit = (kind: AgentEvent["kind"], payload: unknown) => events.push({ taskId: task.taskId, agent: task.agent, sessionId: task.sessionId, kind, payload, ts });
    // Codex response_item is canonical; event_msg repeats the same prose.
    if (task.agent === "codex" && row.type === "response_item") {
      const item = row.payload;
      if (["function_call", "custom_tool_call"].includes(item?.type)) {
        emit("tool_call", { name: item.name, input: item.arguments ?? item.input, id: item.call_id });
        continue;
      }
      if (["function_call_output", "custom_tool_call_output"].includes(item?.type)) {
        const output = extractOutputImages(item.output);
        emit("tool_result", { content: output.payload, tool_use_id: item.call_id });
        for (const img of output.images) emit("output_image", img);
        continue;
      }
    }
    const message = task.agent === "codex" ? row.type === "response_item" && row.payload?.type === "message" ? row.payload : undefined
      : row.type === "user" || row.type === "assistant" ? row.message : undefined;
    if (!message || !["user", "assistant"].includes(message.role)) continue;
    const content = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
    const text = content.filter((b: RecordValue) => ["text", "input_text", "output_text"].includes(b.type) && typeof b.text === "string").map((b: RecordValue) => b.text).join("\n");
    if (text) emit(message.role === "user" ? "status" : "assistant_text", message.role === "user" ? { subtype: "followup", text, source: "local" } : { text });
    const output = extractOutputImages(content);
    for (const img of output.images) emit("output_image", img);
    for (const block of output.payload as RecordValue[]) {
      if (block.type === "tool_use") emit("tool_call", { name: block.name, input: block.input, id: block.id });
      if (block.type === "tool_result") emit("tool_result", { content: block.content, tool_use_id: block.tool_use_id, is_error: block.is_error });
    }
  }
  const next: SessionControl = { ...control, cursor: data.length, prefixHash: hash(data), error: undefined };
  if (!preview) { next.owner = "palmagent"; delete next.waitPid; delete next.waitIdentity; }
  return { control: next, events };
}
export const emptyTranscriptHash = hash(Buffer.alloc(0));
