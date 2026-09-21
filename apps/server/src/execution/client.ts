import { randomUUID } from "node:crypto";
import { ExecutionStartSchema, type ExecutionCommand, type ExecutionCommandResult } from "@palmagent/shared/executions";
import { ExecutionStore, type ExecutionRecord } from "./store.js";
import { admitExecutions, type ExecutionLauncher } from "./launch.js";
import { watchExecutions } from "./wake.js";
import { processIdentity } from "../native-session.js";
import type { AgentKind } from "@palmagent/shared";
import type { ExecutionControlState, AgentRunner, Emit, ProcHandle, RunHandle, RunnerBackend, SpawnSpec, StartArgs } from "../types.js";

/** Replaceable view client. Closing it never closes provider stdin or signals a host. */
export class ExecutionBackend implements RunnerBackend {
  readonly independent = true;
  readonly store: ExecutionStore;
  private dispose: () => void;
  private handles = new Map<string, ExecutionHandle>();
  private closed = false;
  constructor(directory: string, private readonly releaseDirectory: string, private readonly node: string,
    private readonly concurrency: number, private readonly launch?: ExecutionLauncher) {
    this.store = new ExecutionStore(directory);
    this.store.setCapacity(concurrency);
    this.dispose = watchExecutions(directory, () => this.reconcile());
  }
  saveControl(taskId: string, state: ExecutionControlState) { this.store.saveControl(taskId, state); }
  loadControl(taskId: string) { return this.store.loadControl(taskId) as ExecutionControlState | undefined; }
  agentRunner(agent: AgentKind): AgentRunner {
    return { agent, start: (args, emit) => this.open(agent, args, emit) };
  }
  private open(agent: AgentKind, args: StartArgs, emit: Emit): RunHandle {
    const record = args.reattach ? this.store.latest(args.taskId) : this.store.reserve(ExecutionStartSchema.parse({
      taskId: args.taskId, agent, cwd: args.cwd, prompt: args.prompt, images: args.images,
      resumeId: args.resumeId, providerHome: args.providerHome, permission: args.permission,
      model: args.model, effort: args.effort, messageId: args.messageId, interactive: args.interactive,
    }), this.releaseDirectory, this.node, args.skills ?? []);
    if (!record) throw new Error("Execution identity is unavailable; it will not be resumed automatically");
    const handle = new ExecutionHandle(this.store, record, emit);
    this.handles.set(args.taskId, handle);
    if (!args.reattach) admitExecutions(this.store, this.concurrency, this.launch);
    // Give the caller time to register the handle and its completion listener.
    queueMicrotask(() => this.reconcile());
    return handle;
  }
  private reconcile() {
    if (this.closed) return;
    for (const handle of this.handles.values()) {
      try { handle.reconcile(); }
      catch { /* Store/identity uncertainty is connectivity loss, never proof of exit. */ }
    }
    try { admitExecutions(this.store, this.concurrency, this.launch); }
    catch { /* A temporarily unavailable store must not crash the view. */ }
  }
  async listLive(): Promise<string[]> {
    const latest = new Map<string, ExecutionRecord>();
    for (const record of this.store.list()) latest.set(record.taskId, record);
    // Finished journals must still replay if the web was absent at completion.
    return [...latest.keys()];
  }
  release(taskId: string) { this.handles.get(taskId)?.close(); this.handles.delete(taskId); }
  close() {
    this.closed = true; this.dispose();
    for (const handle of this.handles.values()) handle.close();
    this.handles.clear(); this.store.close();
  }
  start(_spec: SpawnSpec): ProcHandle { throw new Error("Execution hosts own provider process creation"); }
  attach(): undefined { throw new Error("Execution hosts own provider protocol attachment"); }
}

class ExecutionHandle implements RunHandle {
  private cursor = 0;
  private ended = false;
  private complete!: () => void;
  private waiters = new Map<string, { resolve: (result: "delivered" | "rejected" | "unknown") => void; timer: NodeJS.Timeout }>();
  readonly done = new Promise<void>((resolve) => { this.complete = resolve; });
  constructor(private readonly store: ExecutionStore, private readonly record: ExecutionRecord, private readonly emit: Emit) {}
  reconcile() {
    if (this.ended) return;
    let current = this.store.get(this.record.id);
    if (current.state === "running" && current.pid && current.identity && processIdentity(current.pid) !== current.identity) {
      this.store.append(current.id, { taskId: current.taskId, kind: "status", payload: { subtype: "process_exit", code: -1 } });
      this.store.finish(current.id, true);
      current = this.store.get(current.id);
    }
    for (const row of this.store.events(current.id, this.cursor)) {
      this.emit(row.event, row.seq); this.cursor = row.seq;
    }
    for (const [id, waiter] of this.waiters) {
      const receipt = this.store.command(current.id, id);
      if (receipt && receipt.result !== "accepted") {
        // A delivered answer and its state event commit together. Project the
        // event before resolving HTTP, even if it arrived during this read.
        if (this.cursor < this.store.get(current.id).lastSeq) { setImmediate(() => this.reconcile()); return; }
        clearTimeout(waiter.timer); this.waiters.delete(id); waiter.resolve(receipt.result);
      }
    }
    if (this.cursor < current.lastSeq) { setImmediate(() => this.reconcile()); return; }
    if (current.state === "finished" || current.state === "lost") { this.ended = true; this.complete(); }
  }
  private command(body: ExecutionCommand, id: string = randomUUID()): ExecutionCommandResult {
    if (this.ended) return "rejected";
    return this.store.enqueue(this.record.id, id, body);
  }
  private async deliveredCommand(body: ExecutionCommand, id: string): Promise<"delivered" | "rejected" | "unknown"> {
    const result = this.command(body, id);
    if (result !== "accepted") return result;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiters.delete(id); resolve("unknown"); }, 15_000);
      this.waiters.set(id, { resolve, timer });
    });
  }
  send = (text: string, images: StartArgs["images"], messageId: string, skills?: StartArgs["skills"]) => {
    // Runs retained from older packages do not carry this capability marker.
    // Their command parser would silently discard a newly added skills field.
    if (skills?.length && this.record.skills === undefined) return Promise.resolve("rejected" as const);
    return this.deliveredCommand({ kind: "send", text, images, messageId, skills }, messageId);
  };
  steer = (text: string, images?: StartArgs["images"]) => this.record.args.agent === "claude" && this.command({ kind: "steer", text, images }) !== "rejected";
  interrupt = () => this.record.args.agent === "claude" && this.command({ kind: "interrupt" }) !== "rejected";
  approve = (decision: string, scope?: string) => this.command({ kind: "approve", decision, scope }) !== "rejected";
  answer: RunHandle["answer"] = async (answer) =>
    await this.deliveredCommand({ kind: "answer", answer }, `answer:${answer.requestId}:${randomUUID()}`) === "delivered";
  cancel = () => {
    if (!this.store.cancelBeforeStart(this.record.id)) this.command({ kind: "cancel" });
  };
  close() {
    this.ended = true;
    for (const waiter of this.waiters.values()) { clearTimeout(waiter.timer); waiter.resolve("unknown"); }
    this.waiters.clear();
    // Do not settle done: shutdown is not the end of the invocation.
  }
}
