import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Repo, Routine, RoutineRun } from "@palmagent/shared";
import { DaemonHostStateSchema } from "@palmagent/shared/daemon";
import { daemonRequest } from "../../../../platform/process/daemon-client.js";
import type { RoutineScriptExecution, RoutineScriptResult, RoutineScriptRunner } from "../../application/ports/outbound/routines.js";
import { RoutineHostStore } from "./routine-host-store.js";

export class DaemonRoutineScriptRunner implements RoutineScriptRunner {
  readonly persistent = true;
  private store: RoutineHostStore;
  constructor(private dataDir: string, private release: string, private node: string,
    private worktrees: { create(repo: Repo, id: string): { path: string } }) {
    this.store = new RoutineHostStore(join(dataDir, "routines"));
  }
  prepare(repo: Repo, script: NonNullable<Routine["script"]>, run: { id: number; routineId: string }) {
    const id = this.store.id(run.id);
    const worktreePath = repo.vcs === "none" ? undefined : this.worktrees.create(repo, `routine-${randomBytes(8).toString("hex")}`).path;
    return { worktreePath, start: () => {
      this.store.create({ protocol: 1, id, runId: run.id, routineId: run.routineId, directory: this.store.directory,
        release: this.release, node: this.node, cwd: worktreePath ?? repo.path, worktreePath, script });
      return this.watch(run.id, run.routineId, worktreePath, true);
    } };
  }
  recover(run: RoutineRun): RoutineScriptExecution { return this.watch(run.id, run.routineId, run.worktreePath, false); }
  acknowledge(runId: number): void { this.store.acknowledge(this.store.id(runId)); }
  private watch(runId: number, routineId: string, worktreePath: string | undefined, launch: boolean): RoutineScriptExecution {
    const id = this.store.id(runId);
    let detached = false, timer: NodeJS.Timeout | undefined;
    let finish!: (result: RoutineScriptResult) => void;
    const done = new Promise<RoutineScriptResult>(resolve => { finish = resolve; });
    const inspect = async () => {
      try {
        const descriptor = this.store.get(id);
        if (descriptor && descriptor.routineId !== routineId) throw new Error("Routine run ownership mismatch");
        const state = DaemonHostStateSchema.parse(await daemonRequest(this.dataDir, { action: "inspect", kind: "routine", id }));
        if (detached) return;
        // Wait for the guardian to confirm all descendants have left before releasing admission.
        if (!state.alive) {
          const result = descriptor && this.store.result(id);
          finish(result || { status: "interrupted", note: "script host ended before completion was recorded", worktreePath, finishedAt: Date.now() });
          return;
        }
      } catch { /* Uncertain ownership retains admission and retries; it never starts another script. */ }
      if (!detached) { timer = setTimeout(() => { void inspect(); }, 1000); timer.unref(); }
    };
    void (async () => {
      if (launch) {
        try { await daemonRequest(this.dataDir, { action: "launch", kind: "routine", id }); }
        catch { /* The daemon may have reserved or started the host. Reconcile; do not relaunch. */ }
      }
      if (!detached) await inspect();
    })();
    return {
      done,
      stop: (reason = "interrupted by user") => this.store.stop(id, reason),
      detach: () => { detached = true; if (timer) clearTimeout(timer); },
    };
  }
}
