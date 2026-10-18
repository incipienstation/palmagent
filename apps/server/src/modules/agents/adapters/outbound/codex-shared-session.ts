import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { Duplex } from "node:stream";
import WebSocket from "ws";
import type { AnswerRequest, InputAttachment, PermissionRequest, QuestionRequest, SkillSelection } from "@palmagent/shared";
import type { SharedSessionConnection, SharedSessionConnector, SharedSessionEvent, SharedSessionSnapshot } from "../../application/ports/inbound/shared-session.js";
import { codexInput } from "./codex-interactive.js";

type Json = Record<string, any>;
class RpcFailure extends Error {}

function openTransport(home: string, cwd: string, socket?: string) {
  const proxy = spawn("codex", ["app-server", "proxy", ...(socket ? ["--sock", socket] : [])],
    { cwd, env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "ignore"] });
  const stream = Duplex.from({ readable: proxy.stdout, writable: proxy.stdin });
  const ws = new WebSocket("ws://localhost/", { createConnection: () => stream, handshakeTimeout: 3000, maxPayload: 64 * 1024 * 1024 });
  proxy.on("error", () => ws.terminate());
  proxy.on("exit", () => ws.terminate());
  return { ws, close: () => { stream.destroy(); proxy.kill(); } };
}

/** The proxy connects to an existing daemon. It never starts or resumes a second writer. */
export class CodexSharedSessions implements SharedSessionConnector {
  constructor(private readonly socket?: string, private readonly transport = openTransport) {}
  async connect(request: Parameters<SharedSessionConnector["connect"]>[0], changed: () => void): Promise<SharedSessionConnection | undefined> {
    if (request.agent !== "codex") return undefined;
    // The proxy is a byte transport, including the WebSocket HTTP upgrade.
    const transport = this.transport(request.home, request.cwd, request.socket ?? this.socket);
    const connection = new CodexConnection(transport.ws, transport.close, request, changed);
    try {
      await connection.open();
      return connection;
    } catch (error) {
      connection.close();
      // A caller may retain preview mode, but must never claim shared ownership.
      throw error;
    }
  }
}

class CodexConnection implements SharedSessionConnection {
  private nextId = 0;
  private closed = false;
  private ready: Promise<void>;
  private pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private requests = new Map<string, { id: string | number; method: string; params: Json }>();
  private responding = new Map<string, { resolve: (value: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
  private initialHistory = true;
  private events: SharedSessionEvent[] = [];
  private streamingText = new Map<string, string>();
  private thread: Json = {};
  private turnId?: string;
  constructor(private ws: WebSocket, private dispose: () => void,
    private target: Parameters<SharedSessionConnector["connect"]>[0], private changed: () => void) {
    this.ready = new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", () => reject(new Error("The Codex shared server is unavailable.")));
      ws.once("close", () => reject(new Error("The Codex shared server disconnected.")));
    });
    ws.on("error", () => this.fail());
    ws.on("close", () => this.fail());
    ws.on("message", data => {
      let row: Json;
      try { row = JSON.parse(String(data)); } catch { this.close(); return; }
      if (!row || typeof row !== "object") { this.close(); return; }
      if ("result" in row || "error" in row) {
        const pending = this.pending.get(row.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(row.id);
        if (row.error) pending.reject(new RpcFailure(row.error.message ?? "Codex rejected the request."));
        else pending.resolve(row.result ?? {});
        return;
      }
      const p = row.params ?? {};
      if (p.threadId !== this.target.sessionId && p.thread?.id !== this.target.sessionId) return;
      if (row.id === undefined && !["serverRequest/resolved", "turn/started", "turn/completed", "item/started", "item/completed", "item/agentMessage/delta", "thread/status/changed"].includes(row.method)) return;
      if (row.id !== undefined) this.requests.set(JSON.stringify(row.id), { id: row.id, method: row.method, params: p });
      if (row.method === "serverRequest/resolved") {
        const key = JSON.stringify(p.requestId), pending = this.responding.get(key);
        this.requests.delete(key);
        if (pending) { clearTimeout(pending.timer); this.responding.delete(key); pending.resolve(true); }
      }
      if (row.method === "turn/started") this.turnId = p.turn?.id;
      if (row.method === "turn/completed") {
        if (!p.turn?.id) { this.close(); return; }
        this.turnId = undefined; this.requests.clear();
        for (const item of p.turn.items ?? []) this.events.push(...this.itemEvents(p.turn.id, item));
        this.events.push(this.resultEvent(p.turn));
        this.streamingText.clear();
      }
      if (row.method === "item/started") {
        if (p.item?.type === "agentMessage" && !this.initialHistory) this.streamingText.set(p.item.id, p.item.text ?? "");
        if (p.item?.type === "commandExecution") this.events.push(this.event(`item/${p.turnId}/${p.item.id}/call`, "tool_call", { id: p.item.id, name: "bash", command: p.item.command }));
      }
      if (row.method === "item/agentMessage/delta" && typeof p.delta === "string" && this.streamingText.has(p.itemId)) {
        const text = this.streamingText.get(p.itemId)! + p.delta;
        this.streamingText.set(p.itemId, text);
        this.events.push(this.event(`item/${p.turnId}/${p.itemId}`, "assistant_text", { text, messageId: p.itemId }));
      }
      if (row.method === "item/completed") {
        this.events.push(...this.itemEvents(p.turnId, p.item));
        this.streamingText.delete(p.item?.id);
      }
      if (row.method === "thread/status/changed") this.thread.status = p.status;
      this.changed();
    });
  }
  private fail() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("The shared connection was lost; delivery is unconfirmed.")); }
    this.pending.clear(); this.dispose(); this.changed();
    for (const pending of this.responding.values()) { clearTimeout(pending.timer); pending.resolve(false); }
    this.responding.clear();
  }
  close() { this.ws.terminate(); this.fail(); }
  private rpc(method: string, params: Json): Promise<Json> {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("The shared connection is unavailable."));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Codex did not confirm the request.")); }, 5000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  async open() {
    await this.ready;
    const initialized = await this.rpc("initialize", { clientInfo: { name: "palmagent", version: "1" }, capabilities: { experimentalApi: true } });
    if (!initialized.codexHome || realpathSync(initialized.codexHome) !== realpathSync(this.target.home)) throw new Error("The shared server uses a different provider home.");
    this.ws.send(JSON.stringify({ method: "initialized" }));
    const { thread } = await this.rpc("thread/read", { threadId: this.target.sessionId, includeTurns: false });
    this.validate(thread);
    // An unloaded thread may rejoin its verified original server. Without a
    // process-bound socket we must not load it in an unrelated daemon.
    if (thread.status?.type === "notLoaded" ? !this.target.socket : thread.canAcceptDirectInput !== true) throw new Error("This session is not running on the Codex shared server. Saved messages remain available in preview.");
    const resumed = await this.rpc("thread/resume", { threadId: this.target.sessionId, excludeTurns: true });
    this.validate(resumed.thread);
    if (resumed.thread.canAcceptDirectInput !== true) throw new Error("The connected session does not accept direct input.");
    this.thread = resumed.thread;
  }
  private validate(thread: Json) {
    if (!thread || thread.id !== this.target.sessionId || realpathSync(thread.cwd) !== realpathSync(this.target.cwd)) throw new Error("The shared session identity or directory does not match.");
  }
  async snapshot(): Promise<SharedSessionSnapshot> {
    const { thread } = await this.rpc("thread/read", { threadId: this.target.sessionId, includeTurns: false });
    this.validate(thread); this.thread = thread;
    if (thread.status?.type === "notLoaded" || thread.canAcceptDirectInput !== true) throw new Error("The shared session is no longer available. Reconnect it from the local CLI.");
    if (thread.status?.type === "systemError") throw new Error("The Codex shared session reported an error.");
    const active = thread.status?.type === "active";
    if (!active) { this.turnId = undefined; this.requests.clear(); }
    let question: QuestionRequest | undefined, approval: PermissionRequest | undefined;
    for (const [requestId, request] of this.requests) {
      const p = request.params;
      if (request.method === "item/tool/requestUserInput" && Array.isArray(p.questions)) question = { requestId, questions: p.questions };
      if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(request.method)) {
        approval = { requestId, tool: request.method === "item/fileChange/requestApproval" ? "file_change" : "bash", input: p, reason: p.reason };
      }
    }
    return { historyMode: thread.historyMode === "paginated" ? "paginated" : "legacy", status: active ? "running" : "idle", turnId: this.turnId, model: thread.model ?? undefined, effort: thread.reasoningEffort ?? undefined, question, approval };
  }
  async history(): Promise<SharedSessionEvent[]> {
    let history: SharedSessionEvent[] = [];
    if (this.initialHistory) {
      let turns: Json[] = [];
      if (this.thread.historyMode === "paginated") {
        let cursor: string | undefined;
        for (let page = 0; ; page++) {
          if (page >= 1000) throw new Error("Shared session history is too large.");
          const result = await this.rpc("thread/turns/list", { threadId: this.target.sessionId, sortDirection: "asc", limit: 100, itemsView: "full", ...(cursor ? { cursor } : {}) });
          turns.push(...result.data);
          if (!result.nextCursor) break;
          if (cursor === result.nextCursor) throw new Error("Shared session history cursor did not advance.");
          cursor = result.nextCursor;
        }
      } else {
        const result = await this.rpc("thread/read", { threadId: this.target.sessionId, includeTurns: true });
        turns = result.thread.turns;
      }
      for (const turn of turns) {
        if (turn.status === "inProgress") this.turnId = turn.id;
        for (const item of turn.items ?? []) {
          // Import current prose immediately. Its completion snapshot fills any
          // suffix missed while reconnecting; persistent prefix checks deduplicate it.
          if (turn.status !== "inProgress" || ["completed", "failed", "declined"].includes(item.status) || item.type === "userMessage" || item.type === "agentMessage") history.push(...this.itemEvents(turn.id, item, turn.status !== "inProgress" || item !== turn.items.at(-1)));
        }
        if (turn.status !== "inProgress") history.push(this.resultEvent(turn));
      }
      this.initialHistory = false;
    }
    const events = [...history, ...this.events]; this.events = [];
    return events;
  }
  private event(key: string, kind: SharedSessionEvent["event"]["kind"], payload: any): SharedSessionEvent {
    return { key, event: { taskId: this.target.taskId, sessionId: this.target.sessionId, kind, payload } as SharedSessionEvent["event"] };
  }
  private itemEvents(turnId: string, item: Json, completed = true): SharedSessionEvent[] {
    if (!turnId || !item?.id) return [];
    const key = `item/${turnId}/${item.id}`;
    switch (item.type) {
      case "userMessage": return [this.event(key, "status", { subtype: "followup", source: "local", text: (item.content ?? []).filter((v: Json) => v.type === "text").map((v: Json) => v.text).join("\n"), ...(item.clientId ? { messageId: item.clientId } : {}) })];
      case "agentMessage": {
        const phase = item.phase === "commentary" ? "progress" : item.phase === "partial_answer" ? "partial" : item.phase === "final_answer" ? "final" : undefined;
        return [this.event(key, "assistant_text", { text: item.text ?? "", messageId: item.id }),
          ...(completed && phase ? [this.event(`${key}/phase/${phase}`, "status", { subtype: "assistant_message", messageId: item.id, phase })] : [])];
      }
      case "commandExecution": return [this.event(key + "/call", "tool_call", { id: item.id, name: "bash", command: item.command }), this.event(key + "/result", "tool_result", { tool_use_id: item.id, output: item.aggregatedOutput, exit_code: item.exitCode })];
      case "fileChange": return [this.event(key, "tool_call", { id: item.id, name: "file_change", changes: item.changes })];
      case "mcpToolCall": return [this.event(key, "tool_result", { tool_use_id: item.id, name: item.tool, content: item.result, is_error: !!item.error })];
      case "functionCallOutput": return [this.event(key, "tool_result", { tool_use_id: item.id, name: item.name, content: item.output })];
      case "webSearch": return [this.event(key, "tool_result", { tool_use_id: item.id, name: "web_search", content: item.action })];
      case "contextCompaction": return [this.event(key, "status", { subtype: "context_compaction_started" })];
      default: return [];
    }
  }
  private resultEvent(turn: Json): SharedSessionEvent {
    return this.event(`turn/${turn.id}/result`, "result", { turnId: turn.id, is_error: turn.status !== "completed", subtype: turn.status, error: turn.error });
  }
  async send(text: string, images: InputAttachment[] | undefined, messageId: string, skills?: SkillSelection[]) {
    let submitted = false;
    try {
      const snapshot = await this.snapshot();
      const active = snapshot.status === "running";
      if (active && !this.turnId) await this.history();
      if (active && !this.turnId) return "rejected" as const;
      // Send now reaches the loaded thread's current turn. A turn changing
      // between the read and steer is an explicit rejection, never a second writer.
      submitted = true;
      const result = await this.rpc(active ? "turn/steer" : "turn/start", {
        threadId: this.target.sessionId, clientUserMessageId: messageId, input: codexInput(text, images, skills),
        ...(active ? { expectedTurnId: this.turnId } : {}),
      });
      this.turnId = result.turnId ?? result.turn?.id; this.changed();
      return "delivered" as const;
    } catch (error) { return !submitted || error instanceof RpcFailure ? "rejected" as const : "unknown" as const; }
  }
  async interrupt() {
    if (!this.turnId) return false;
    try { await this.rpc("turn/interrupt", { threadId: this.target.sessionId, turnId: this.turnId }); return true; } catch { return false; }
  }
  private respond(requestId: string, result: Json): Promise<boolean> {
    const request = this.requests.get(requestId);
    if (!request || this.closed || this.responding.has(requestId)) return Promise.resolve(false);
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.responding.delete(requestId); resolve(false); }, 5000);
      timer.unref();
      this.responding.set(requestId, { resolve, timer });
      this.ws.send(JSON.stringify({ id: request.id, result }), error => {
        if (error) { clearTimeout(timer); this.responding.delete(requestId); resolve(false); }
      });
    });
  }
  approve(requestId: string, decision: string) {
    if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(this.requests.get(requestId)?.method ?? "")) return Promise.resolve(false);
    if (!["approve", "deny", "accept", "decline"].includes(decision)) return Promise.resolve(false);
    return this.respond(requestId, { decision: decision === "approve" || decision === "accept" ? "accept" : "decline" });
  }
  answer(request: AnswerRequest) {
    const pending = this.requests.get(request.requestId);
    if (pending?.method !== "item/tool/requestUserInput") return Promise.resolve(false);
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of pending.params.questions ?? []) {
      const matches = request.answers.filter(a => a.questionId ? a.questionId === question.id : a.question === question.question);
      if (matches.length > 1) return Promise.resolve(false);
      const answer = matches[0];
      const values = [...(answer?.selected ?? []), ...[answer?.notes?.trim(), request.response?.trim()].filter((s): s is string => !!s)];
      if (values.length) answers[question.id] = { answers: values };
    }
    return this.respond(request.requestId, { answers });
  }
}
