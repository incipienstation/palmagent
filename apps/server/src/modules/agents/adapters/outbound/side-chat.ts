import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { SideChatSend, SideChatSnapshot } from "@palmagent/shared";
import type { SideChatOperations, SideChatTarget } from "../../application/ports/inbound/side-chat.js";
import { ApplicationError } from "../../../../kernel/errors.js";

type Json = Record<string, any>;
type Launch = (target: SideChatTarget) => ChildProcessWithoutNullStreams;
const unavailable = (message = "Side chat is unavailable. Check your Codex connection and try again.") => new ApplicationError("service_unavailable", message);
const launch: Launch = target => spawn("codex", ["app-server", "--listen", "stdio://",
  "--disable", "hooks", "--disable", "multi_agent"],
{ cwd: target.cwd, env: { ...process.env, CODEX_HOME: target.home }, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });

// Each side chat owns an ephemeral fork and process. No turn is submitted to,
// resumed on, or interrupted on the parent's thread.
export class CodexSideChats implements SideChatOperations {
  private sessions = new Map<string, SideConversation>();
  private closed = false;
  constructor(private spawnSide: Launch = launch, private leaseMs = 30 * 60_000, private rpcMs = 20_000) {}
  get(taskId: string) { return this.sessions.get(taskId)?.snapshot() ?? null; }
  async open(target: SideChatTarget) {
    if (this.closed) throw unavailable();
    let session = this.sessions.get(target.taskId);
    if (!session || session.state.status === "ended") {
      if ([...this.sessions.values()].filter(s => s.state.status !== "ended").length >= 8)
        throw new ApplicationError("too_many_requests", "End another side chat before starting one.");
      for (const [id, old] of this.sessions) {
        if (this.sessions.size < 100) break;
        if (old.state.status === "ended") this.sessions.delete(id);
      }
      session = new SideConversation(target, this.spawnSide, this.leaseMs, this.rpcMs);
      this.sessions.set(target.taskId, session);
    }
    await session.ready;
    return session.snapshot();
  }
  private session(taskId: string, id: string) {
    const session = this.sessions.get(taskId);
    if (!session || session.state.id !== id) throw new ApplicationError("gone", "This side chat has ended. Start a new side chat.");
    return session;
  }
  send(taskId: string, message: SideChatSend) { return this.session(taskId, message.sessionId).send(message); }
  stop(taskId: string, sessionId: string) { return this.session(taskId, sessionId).stop(); }
  end(taskId: string, sessionId: string) {
    const session = this.session(taskId, sessionId);
    session.end();
    return session.snapshot();
  }
  close() { this.closed = true; for (const session of this.sessions.values()) session.end(); this.sessions.clear(); }
}

class SideConversation {
  readonly state: SideChatSnapshot = { id: randomUUID(), status: "starting", messages: [], revision: 0, completed: 0 };
  readonly ready: Promise<void>;
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, { resolve(value: Json): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 1;
  private threadId = "";
  private turnId = "";
  private buffer = "";
  private lease?: ReturnType<typeof setTimeout>;
  private sent = new Map<string, string>();
  private totalText = 0;
  constructor(private target: SideChatTarget, spawnSide: Launch, private leaseMs: number, private rpcMs: number) {
    this.child = spawnSide(target);
    this.child.stderr.resume();
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.receive(chunk));
    this.child.on("error", () => this.end("The side chat connection failed. Start a new side chat."));
    this.child.on("exit", () => this.end("The side chat connection ended. Start a new side chat."));
    this.child.stdin.on("error", () => this.end("The side chat connection ended. Start a new side chat."));
    this.touch();
    this.ready = this.initialize();
    // Opening HTTP requests may disconnect while initialization is pending.
    void this.ready.catch(() => {});
  }
  private async initialize() {
    try {
      await this.rpc("initialize", { clientInfo: { name: "palmagent_side_chat", version: "1" }, capabilities: { experimentalApi: true } });
      this.write({ method: "initialized" });
      const result = await this.rpc("thread/fork", {
        threadId: this.target.sessionId, cwd: this.target.cwd, ephemeral: true, excludeTurns: true,
        sandbox: "read-only", approvalPolicy: "never",
        developerInstructions: "This is a side conversation. Answer the user's side questions using the inherited context. Do not continue the parent task or its goal. Do not edit files or perform external write actions.",
        config: { "features.apps": false, "features.hooks": false, "features.multi_agent": false },
      });
      if (!result.thread?.id || result.thread.id === this.target.sessionId || result.thread.ephemeral !== true)
        throw unavailable("This Codex version cannot create an isolated side chat. Update Codex and try again.");
      this.threadId = result.thread.id;
      // Ephemeral forks do not support goals. Do not use the persistent-fork
      // deferGoalContinuation option or goal RPCs on this thread.
      this.state.status = "idle"; this.state.revision++;
    } catch (error) {
      this.end(error instanceof ApplicationError ? error.message : "Could not start side chat. Check Codex support and try again.");
      throw unavailable(this.state.error);
    }
  }
  private touch() {
    clearTimeout(this.lease);
    if (this.state.status !== "ended") {
      this.lease = setTimeout(() => this.end("Side chat expired after inactivity. Start a new side chat."), this.leaseMs);
      this.lease.unref();
    }
  }
  snapshot(): SideChatSnapshot { this.touch(); return structuredClone(this.state); }
  private write(value: unknown) {
    if (this.state.status === "ended") throw unavailable("This side chat has ended.");
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  private rpc(method: string, params: Json): Promise<Json> {
    if (this.state.status === "ended") return Promise.reject(unavailable("This side chat has ended."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(unavailable("Codex did not confirm the side chat request."));
        this.end("The connection was lost. Delivery could not be confirmed; the message was not resent.");
      }, this.rpcMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private receive(chunk: string) {
    if (this.state.status === "ended") return;
    this.buffer += chunk;
    if (this.buffer.length > 2_000_000) return this.end("Side chat reached its response limit.");
    let end: number;
    while ((end = this.buffer.indexOf("\n")) !== -1 && !this.isEnded()) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      let row: Json;
      try { row = JSON.parse(line); if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(); }
      catch { this.end("The side chat connection returned an invalid response."); return; }
      if (row.id !== undefined && !row.method) {
        const pending = this.pending.get(row.id);
        if (pending) {
          clearTimeout(pending.timer); this.pending.delete(row.id);
          if (row.error) pending.reject(unavailable("Codex rejected the side chat request."));
          else pending.resolve(row.result ?? {});
        }
        continue;
      }
      const p = row.params ?? {};
      if (row.id !== undefined && row.method) {
        this.write({ id: row.id, error: { code: -32601, message: "Side chat does not support interactive tool requests." } });
        this.end("This question requires an interactive action. Continue it in the main chat.");
        return;
      }
      if (!this.threadId || p.threadId !== this.threadId) continue;
      if (row.method === "turn/started") this.turnId = p.turn?.id ?? "";
      if (row.method === "item/agentMessage/delta" && typeof p.delta === "string") this.text(p.turnId ?? this.turnId, p.itemId, p.delta, false);
      if (row.method === "item/completed" && p.item?.type === "agentMessage") this.text(p.turnId ?? this.turnId, p.item.id, p.item.text ?? "", true);
      if (row.method === "turn/completed") {
        this.turnId = ""; this.state.status = "idle"; this.state.completed++; this.state.revision++;
        if (p.turn?.status === "failed") this.state.error = "The side chat response failed. You can ask a follow-up or start again.";
      }
      if (row.method === "error" && !p.willRetry) {
        this.state.error = "Codex could not finish the side chat response."; this.state.revision++;
      }
    }
  }
  private isEnded() { return this.state.status === "ended"; }
  private text(turnId: string, itemId: string, value: string, complete: boolean) {
    if (typeof turnId !== "string" || !turnId || typeof itemId !== "string" || typeof value !== "string") return;
    const id = `${turnId}/${itemId}`;
    let message = this.state.messages.find(m => m.role === "assistant" && m.id === id);
    if (!message) { message = { id, role: "assistant", text: "" }; this.state.messages.push(message); }
    const next = complete ? value : message.text + value;
    this.totalText += next.length - message.text.length;
    if (this.totalText > 1_000_000 || this.state.messages.length > 200) return this.end("Side chat reached its conversation limit. Start a new side chat.");
    message.text = next; this.state.revision++;
  }
  async send(message: SideChatSend) {
    await this.ready;
    const previous = this.sent.get(message.messageId);
    if (previous !== undefined) {
      if (previous !== message.text) throw new ApplicationError("conflict", "This message ID has already been used.");
      return this.snapshot();
    }
    if (this.state.status !== "idle") throw new ApplicationError("conflict", "Wait for the side chat response before sending another question.");
    if (this.sent.size >= 100 || this.state.messages.length >= 200 || this.totalText + message.text.length > 1_000_000) {
      this.end("Side chat reached its conversation limit."); throw unavailable(this.state.error);
    }
    this.sent.set(message.messageId, message.text);
    this.state.messages.push({ id: message.messageId, role: "user", text: message.text });
    this.totalText += message.text.length;
    this.state.status = "running"; this.state.error = undefined; this.state.revision++;
    try {
      const result = await this.rpc("turn/start", { threadId: this.threadId,
        input: [{ type: "text", text: message.text, text_elements: [] }] });
      if (this.state.status === "running") this.turnId = result.turn?.id ?? this.turnId;
    } catch {
      this.end("The question could not be confirmed. It was not resent. Start a new side chat to continue.");
    }
    return this.snapshot();
  }
  async stop() {
    if (this.state.status === "running") {
      if (!this.turnId) throw new ApplicationError("conflict", "The side response is starting. Try stopping again shortly.");
      await this.rpc("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
    }
    return this.snapshot();
  }
  end(error?: string) {
    if (this.state.status === "ended") return;
    this.state.status = "ended"; this.state.error = error; this.state.revision++;
    clearTimeout(this.lease);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(unavailable(error ?? "Side chat ended.")); }
    this.pending.clear();
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, signal);
        else this.child.kill(signal);
      } catch { /* The owned process group has already exited. */ }
    };
    this.child.stdin.end(); kill("SIGTERM");
    const force = setTimeout(() => kill("SIGKILL"), 1000);
    force.unref();
    this.child.once("close", () => { clearTimeout(force); kill("SIGKILL"); });
  }
}
