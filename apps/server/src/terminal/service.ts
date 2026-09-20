import { realpathSync } from "node:fs";
import type { CreateTerminalRequest } from "@palmagent/shared/terminals";
import { publicTerminal, TerminalStore } from "./store.js";
import type { TerminalSupervisor } from "./platform.js";
import type { Repo, TaskState } from "@palmagent/shared";
import { HttpError } from "../service.js";
import { writePrivateFileAtomic } from "../private-files.js";
import { join } from "node:path";

export class TerminalService {
  private timer?: ReturnType<typeof setInterval>;
  private reconciliation?: Promise<void>;
  constructor(readonly store: TerminalStore, readonly supervisor: TerminalSupervisor,
    private targets: { task(id: string): TaskState; repo(id: string): Repo | undefined; cleanup(taskId: string): void; updating(): boolean },
    private release: string, private node: string) {}
  capabilities() { return this.supervisor.capabilities; }
  start() { void this.reconcile(); this.timer = setInterval(() => void this.reconcile(), 5000); this.timer.unref(); }
  list(query: { taskId?: string; repoId?: string } = {}) {
    return this.store.list().filter(r => (!query.taskId || r.taskId === query.taskId) && (!query.repoId || r.repoId === query.repoId)).map(publicTerminal);
  }
  get(id: string) {
    const record = this.store.get(id);
    if (!record) throw new HttpError(404, "Terminal not found");
    return record;
  }
  async create(input: CreateTerminalRequest) {
    if (!this.capabilities().available) throw new HttpError(503, this.capabilities().reason ?? "Terminals are unavailable on this platform");
    if (this.targets.updating()) throw new HttpError(409, "Installation maintenance is in progress");
    const existing = this.store.list().find(r => r.requestId === input.requestId);
    if (existing) {
      if ("taskId" in input.target ? existing.taskId !== input.target.taskId : existing.repoId !== input.target.repoId || existing.taskId) throw new HttpError(409, "Request belongs to another target");
      return publicTerminal(existing);
    }
    const task = "taskId" in input.target ? this.targets.task(input.target.taskId) : undefined;
    if (task && ["cancelled", "archived"].includes(task.status)) throw new HttpError(409, "Open a terminal from an active task or its Space");
    const repoId = task?.repoId ?? ("repoId" in input.target ? input.target.repoId : "");
    const repo = this.targets.repo(repoId);
    if (!repo) throw new HttpError(404, "Space not found");
    let cwd: string;
    try { cwd = realpathSync(task?.worktreePath ?? repo.path); } catch { throw new HttpError(409, "Working directory is unavailable"); }
    let reserved;
    try { reserved = this.store.reserve({ requestId: input.requestId, taskId: task?.taskId, repoId, title: input.title ?? "Shell",
      initialCwd: cwd, cols: input.cols, rows: input.rows, release: this.release, node: this.node, directory: this.store.directory }); }
    catch (error) { throw new HttpError(409, error instanceof Error ? error.message : "Terminal could not be reserved"); }
    if (reserved.created) await this.launch(reserved.record.id);
    return publicTerminal(this.get(reserved.record.id));
  }
  private async launch(id: string) {
    const record = this.get(id);
    writePrivateFileAtomic(join(this.store.directory, id + ".json"), JSON.stringify({ id, protocol: record.protocol, directory: record.directory, release: record.release, node: record.node }));
    try {
      await this.supervisor.launch(record);
      if (this.get(id).state === "starting") this.store.update(id, { startError: undefined });
    } catch {
      if (this.get(id).state === "starting") this.store.update(id, { startError: "Shell launch could not be confirmed. Palmagent will retry this terminal; check the installation's terminal service." });
      throw new HttpError(503, "Shell launch could not be confirmed. Check this terminal's status before opening another.");
    }
  }
  rename(id: string, title: string) { this.get(id); return publicTerminal(this.store.update(id, { title })); }
  async terminate(id: string) {
    const record = this.get(id);
    if (["exited", "lost"].includes(record.state)) return publicTerminal(record);
    this.store.update(id, { state: "closing" });
    await this.supervisor.terminate(record);
    // A successful supervisor stop confirms the complete process group has exited.
    const next = this.store.update(id, { state: "exited" });
    await this.reconcile();
    return publicTerminal(next);
  }
  reconcile(): Promise<void> {
    return this.reconciliation ??= this.reconcileOnce().finally(() => { this.reconciliation = undefined; });
  }
  private async reconcileOnce() {
    for (const record of this.store.list()) {
      try {
        if (record.state === "starting" && !record.pid) {
          if (this.capabilities().available) await this.launch(record.id);
          else this.store.update(record.id, { startError: this.capabilities().reason ?? "Terminal services are unavailable." });
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
  async close() { clearInterval(this.timer); await this.reconciliation; this.store.close(); }
}
