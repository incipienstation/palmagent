import type { CreateRoutineRequest, UpdateRoutineRequest } from "@palmagent/shared";
import type { RoutineUseCases } from "../ports/inbound/routine-use-cases.js";
import type { ScriptRuntime } from "../ports/outbound/script-runtime.js";
import type { RoutineService } from "./routine-service.js";
import type { TaskEventPublisher } from "../../../../kernel/events.js";

/** Agent routines stay local during this migration stage; scripts have one native writer. */
export class IndependentRoutines implements RoutineUseCases {
  private timer?: ReturnType<typeof setInterval>;
  private refreshing?: Promise<void>;
  private closed = false;
  private observed?: string;
  private scripts = 0;
  constructor(private readonly local: RoutineService, private readonly native: ScriptRuntime,
    private readonly events: Pick<TaskEventPublisher, "emitReadChange">) {}
  get activeScriptCount() { return this.scripts; }
  get updateBlockingScriptCount() { return 0; }
  async initialize() { await this.refresh(); }
  start() {
    this.local.start();
    this.closed = false;
    this.timer = setInterval(() => { void this.refresh().catch(() => {}); }, 1000);
    this.timer.unref();
  }
  async stop() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.local.stop();
  }
  private refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.refreshing ??= this.readStatus().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async readStatus() {
    const status = await this.native.status();
    if (this.closed) return;
    this.scripts = status.activeScripts;
    const key = `${status.instance}:${status.revision}`;
    if (key !== this.observed) {
      this.observed = key;
      this.events.emitReadChange({ type: "read-change", routines: true });
    }
  }
  private async changed<T>(operation: Promise<T>): Promise<T> {
    const result = await operation;
    // A poll started before this mutation may still contain the previous count.
    // Settle it first, then refresh so health and read invalidations reflect admission.
    await this.refreshing?.catch(() => {});
    await this.refresh().catch(() => {});
    // A failed observation must not turn a confirmed mutation into a retryable failure.
    return result;
  }
  private script(id: string) { return this.local.get(id).kind === "script"; }
  context() { return this.local.context(); }
  // Both owners commit to the same schema. Reuse the existing read projection;
  // fetching scripts over IPC and rereading them locally duplicates the hot path.
  list() { return this.local.list(); }
  get(id: string) { return this.local.get(id); }
  create(input: CreateRoutineRequest) { return input.kind === "script" ? this.changed(this.native.create(input)) : this.local.create(input); }
  update(id: string, input: UpdateRoutineRequest) { return this.script(id) ? this.changed(this.native.update(id, input)) : this.local.update(id, input); }
  remove(id: string) { return this.script(id) ? this.changed(this.native.remove(id)) : this.local.remove(id); }
  runNow(id: string) { return this.script(id) ? this.changed(this.native.run(id)) : this.local.runNow(id); }
  stopRun(id: string) { return this.script(id) ? this.changed(this.native.stop(id)) : this.local.stopRun(id); }
  runs(id: string, limit?: number) { return this.local.runs(id, limit); }
}
