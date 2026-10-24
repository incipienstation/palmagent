import type { CreateRoutineRequest, UpdateRoutineRequest } from "@palmagent/shared";
import type { RoutineUseCases } from "../ports/inbound/routine-use-cases.js";
import type { ScriptRuntime } from "../ports/outbound/script-runtime.js";
import type { RoutineService } from "./routine-service.js";
import type { TaskEventPublisher } from "../../../../kernel/events.js";

/** Agent routines stay local during this migration stage; scripts have one native writer. */
export class IndependentRoutines implements RoutineUseCases {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
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
  private async refresh() {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      const status = await this.native.status();
      if (this.closed) return;
      this.scripts = status.activeScripts;
      const key = `${status.instance}:${status.revision}`;
      if (key !== this.observed) {
        this.observed = key;
        this.events.emitReadChange({ type: "read-change", routines: true });
      }
    } finally { this.busy = false; }
  }
  private script(id: string) { return this.local.get(id).kind === "script"; }
  context() { return this.local.context(); }
  async list() {
    const scripts = await this.native.list();
    return [...this.local.list().filter(r => r.kind !== "script"), ...scripts].sort((a, b) => a.createdAt - b.createdAt);
  }
  get(id: string) { return this.script(id) ? this.native.get(id) : this.local.get(id); }
  create(input: CreateRoutineRequest) { return input.kind === "script" ? this.native.create(input) : this.local.create(input); }
  update(id: string, input: UpdateRoutineRequest) { return this.script(id) ? this.native.update(id, input) : this.local.update(id, input); }
  remove(id: string) { return this.script(id) ? this.native.remove(id) : this.local.remove(id); }
  runNow(id: string) { return this.script(id) ? this.native.run(id) : this.local.runNow(id); }
  stopRun(id: string) { return this.script(id) ? this.native.stop(id) : this.local.stopRun(id); }
  runs(id: string, limit?: number) { return this.script(id) ? this.native.runs(id) : this.local.runs(id, limit); }
}
