import type { TerminalUseCases } from "../ports/inbound/terminal-use-cases.js";
import { isClosedTaskStatus } from "@palmagent/shared";
import type { CreateTerminalRequest } from "@palmagent/shared/terminals";
import { publicTerminal } from "../../domain/terminal.js";
import type { TerminalRegistry, TerminalFiles } from "../ports/outbound/terminal-registry.js";
import type { TerminalSupervisor } from "../ports/outbound/terminal-platform.js";
import type { Repo, TaskState } from "@palmagent/shared";
import { ApplicationError } from "../../../../kernel/errors.js";

export class TerminalService implements TerminalUseCases {
  private timer?: ReturnType<typeof setInterval>;
  private reconciliation?: Promise<void>;
  private unwatch?: () => void;
  private launches = new Map<string, Promise<void>>();
  private snapshot = "";
  private publishChanges() {
    const next = JSON.stringify({ terminals: this.list(), capabilities: this.capabilities() });
    if (next === this.snapshot) return false;
    this.snapshot = next; this.changed();
    return true;
  }
  constructor(readonly store: TerminalRegistry, readonly supervisor: TerminalSupervisor,
    private targets: { task(id: string): TaskState; repo(id: string): Repo | undefined; cleanup(taskId: string): void; updating(): boolean },
    private release: string, private node: string, private files: TerminalFiles, private changed: () => void = () => {}) {}
  capabilities() { return this.supervisor.capabilities; }
  start() {
    this.snapshot = JSON.stringify({ terminals: this.list(), capabilities: this.capabilities() });
    this.unwatch = this.store.watch(() => { if (this.publishChanges()) void this.reconcile(); });
    void this.reconcile();
    // Recovery for ungraceful process deaths or missed filesystem notifications.
    this.timer = setInterval(() => void this.reconcile(), 5000); this.timer.unref();
  }
  list(query: { taskId?: string; repoId?: string } = {}) {
    return this.store.list().filter(r => (!r.diagnostic || r.diagnosticCleanupFailed) && (!query.taskId || r.taskId === query.taskId) && (!query.repoId || r.repoId === query.repoId)).map(publicTerminal);
  }
  get(id: string) {
    const record = this.store.get(id);
    if (!record) throw new ApplicationError("not_found", "Terminal not found");
    return record;
  }
  getPublic(id: string) { return publicTerminal(this.get(id)); }
  async create(input: CreateTerminalRequest) {
    if (!this.capabilities().available) throw new ApplicationError("service_unavailable", this.capabilities().reason ?? "Terminals are unavailable on this platform");
    if (this.targets.updating()) throw new ApplicationError("conflict", "Installation maintenance is in progress");
    const existing = this.store.list().find(r => r.requestId === input.requestId);
    if (existing) {
      if ("taskId" in input.target ? existing.taskId !== input.target.taskId : existing.repoId !== input.target.repoId || existing.taskId) throw new ApplicationError("conflict", "Request belongs to another target");
      return publicTerminal(existing);
    }
    const task = "taskId" in input.target ? this.targets.task(input.target.taskId) : undefined;
    if (task && isClosedTaskStatus(task.status)) throw new ApplicationError("conflict", "Open a terminal from an active task or its Space");
    const repoId = task?.repoId ?? ("repoId" in input.target ? input.target.repoId : "");
    const repo = this.targets.repo(repoId);
    if (!repo) throw new ApplicationError("not_found", "Space not found");
    let cwd: string;
    try { cwd = this.files.resolveDirectory(task?.worktreePath ?? repo.path); } catch { throw new ApplicationError("conflict", "Working directory is unavailable"); }
    let reserved;
    try { reserved = this.store.reserve({ requestId: input.requestId, taskId: task?.taskId, repoId, title: input.title ?? "Shell",
      initialCwd: cwd, cols: input.cols, rows: input.rows, release: this.release, node: this.node, directory: this.store.directory }); }
    catch (error) { throw new ApplicationError("conflict", error instanceof Error ? error.message : "Terminal could not be reserved"); }
    this.publishChanges();
    if (reserved.created) await this.launch(reserved.record.id);
    return publicTerminal(this.get(reserved.record.id));
  }
  private launch(id: string): Promise<void> {
    const active = this.launches.get(id);
    if (active) return active;
    const pending = this.launchOnce(id).finally(() => { this.launches.delete(id); });
    this.launches.set(id, pending);
    return pending;
  }
  private async launchOnce(id: string) {
    const record = this.get(id);
    this.files.writeLaunchDescriptor(this.store.directory, record);
    try {
      await this.supervisor.launch(record);
    } catch {
      this.store.noteStartError(id, "launch_unconfirmed", "Shell launch could not be confirmed. Palmagent will retry this terminal; check the installation's terminal service.");
      throw new ApplicationError("service_unavailable", "Shell launch could not be confirmed. Check this terminal's status before opening another.");
    }
  }
  rename(id: string, title: string) { this.get(id); const next = publicTerminal(this.store.update(id, { title })); this.publishChanges(); return next; }
  async terminate(id: string) {
    const record = this.get(id);
    if (["exited", "lost"].includes(record.state)) return publicTerminal(record);
    this.store.update(id, { state: "closing" });
    this.publishChanges();
    await this.supervisor.terminate(record);
    // A successful supervisor stop confirms the complete process group has exited.
    const next = this.store.update(id, { state: "exited" });
    await this.reconcile();
    return publicTerminal(next);
  }
  reconcile(): Promise<void> {
    return this.reconciliation ??= this.reconcileOnce().finally(() => { this.reconciliation = undefined; this.publishChanges(); });
  }
  private async reconcileOnce() {
    for (const record of this.store.list()) {
      try {
        if (this.store.expireStartup(record.id)) {
          // Only a confirmed stop releases retention. Never relaunch an expired ID.
          await this.supervisor.terminate(record);
          this.store.update(record.id, { state: "lost", startErrorCode: "startup_timeout", startError: "Shell startup timed out and was stopped. Check the installation with palmagent doctor before trying again." });
        } else if (record.state === "starting") {
          if (record.pid) {
            if (!await this.supervisor.alive(record)) this.store.update(record.id, { state: "lost", startErrorCode: "host_exited", startError: "The shell host exited before it became ready. Check the terminal service log." });
          } else if (this.capabilities().available) await this.launch(record.id);
          else this.store.noteStartError(record.id, "services_unavailable", this.capabilities().reason ?? "Terminal services are unavailable.");
        }
        else if (["running", "closing"].includes(record.state) && !await this.supervisor.alive(record)) {
          const latest = this.get(record.id);
          this.store.update(record.id, { state: latest.exitCode === undefined ? "lost" : "exited" });
        }
      } catch { /* Preserve uncertain reservations; never create a replacement invocation. */ }
    }
    for (const entry of this.store.pendingCleanup()) {
      try { this.targets.cleanup(entry.taskId); } catch { /* Retry after the next reconciliation. */ }
    }
  }
  async close() { this.unwatch?.(); clearInterval(this.timer); try { await this.reconciliation; } finally { this.store.close(); } }
}
