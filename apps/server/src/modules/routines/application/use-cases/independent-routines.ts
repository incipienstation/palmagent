import type { CreateTaskRequest, TaskState, CreateRoutineRequest, UpdateRoutineRequest } from "@palmagent/shared";
import type { RoutineUseCases } from "../ports/inbound/routine-use-cases.js";
import { ApplicationError } from "../../../../kernel/errors.js";
import type { RoutineTaskUseCases } from "../ports/outbound/routines.js";
import type { AgentDispatch, RoutineRuntime } from "../ports/outbound/routine-runtime.js";
import type { RoutineService } from "./routine-service.js";
import type { TaskEventPublisher } from "../../../../kernel/events.js";

/** All mutations target the native owner. Only the ready Tasks coordinator delivers agent runs. */
export class IndependentRoutines implements RoutineUseCases {
  private timer?: ReturnType<typeof setInterval>;
  private agentTimer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;
  private deliveries = new Map<number, Promise<void>>();
  private refreshing?: Promise<void>;
  private closed = false;
  private observed?: string;
  private scripts = 0;
  constructor(private readonly local: RoutineService, private readonly native: RoutineRuntime,
    private readonly events: Pick<TaskEventPublisher, "emitReadChange">, private readonly tasks: RoutineTaskUseCases & { createdTask(req: CreateTaskRequest): TaskState | undefined }) {}
  get activeScriptCount() { return this.scripts; }
  get updateBlockingScriptCount() { return 0; }
  async initialize() {
    await this.refresh();
    const pending = await this.native.agentTick(true);
    // Keep the API available if an admitted request's receipt is temporarily unwritable.
    await this.drain(pending).catch(() => {});
  }
  start() {
    if (this.timer) return;
    this.closed = false;
    this.timer = setInterval(() => { void this.refresh().catch(() => {}); }, 1000);
    this.timer.unref();
    this.agentTimer = setInterval(() => {
      if (this.tasks.updating) return;
      this.ticking ??= this.native.agentTick(false).then(pending => this.drain(pending)).catch(() => {}).finally(() => { this.ticking = undefined; });
    }, 15_000);
    this.agentTimer.unref();
  }
  async stop() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.agentTimer) clearInterval(this.agentTimer);
    this.agentTimer = undefined;
    await this.ticking;
    await Promise.allSettled(this.deliveries.values());
  }
  private async drain(dispatch: AgentDispatch | null) {
    while (dispatch && !this.closed && !this.tasks.updating) {
      await this.deliver(dispatch);
      dispatch = await this.native.nextDispatch();
    }
  }
  private deliver(dispatch: AgentDispatch): Promise<void> {
    const current = this.deliveries.get(dispatch.id);
    if (current) return current;
    const sending = this.send(dispatch).finally(() => this.deliveries.delete(dispatch.id));
    this.deliveries.set(dispatch.id, sending);
    return sending;
  }
  private async send(dispatch: AgentDispatch) {
    if (this.closed || this.tasks.updating) throw new ApplicationError("service_unavailable", "Task admission is paused");
    let receipt: { taskId?: string; note?: string };
    try {
      receipt = { taskId: this.tasks.createTask(dispatch.task).taskId };
    } catch (error) {
      if (error instanceof ApplicationError && ["service_unavailable", "update_in_progress"].includes(error.code)) throw error;
      // A post-commit failure may leave a real Task. A disconnected Tasks owner
      // cannot confirm absence and its pending receipt is retried on the next tick.
      const committed = this.tasks.createdTask(dispatch.task);
      receipt = committed ? { taskId: committed.taskId } : { note: error instanceof Error ? error.message : String(error) };
    }
    await this.native.settleDispatch(dispatch.id, receipt);
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
  context() { return this.local.context(); }
  // Read the shared committed projection without a scheduler round trip.
  list() { return this.local.list(); }
  get(id: string) { return this.local.get(id); }
  create(input: CreateRoutineRequest) { return this.changed(this.native.create(input)); }
  update(id: string, input: UpdateRoutineRequest) { return this.changed(this.native.update(id, input)); }
  remove(id: string) { return this.changed(this.native.remove(id)); }
  async runNow(id: string) {
    const { routine, dispatch } = await this.native.run(id);
    // An admitted run survives a disconnected receipt and will be retried by the coordinator.
    if (dispatch) await this.deliver(dispatch).catch(() => {});
    return this.changed(Promise.resolve(routine));
  }
  stopRun(id: string) { return this.changed(this.native.stop(id)); }
  runs(id: string, limit?: number) { return this.local.runs(id, limit); }
}
