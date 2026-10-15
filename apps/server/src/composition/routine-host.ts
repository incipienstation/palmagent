import { RoutineHostStore } from "../modules/routines/adapters/outbound/routine-host-store.js";
import { runRoutineScript } from "../modules/routines/adapters/outbound/local-script-runner.js";

export async function runRoutineHost(directory: string, id: string, ready: () => void = () => {}): Promise<void> {
  const store = new RoutineHostStore(directory);
  const descriptor = store.get(id);
  if (!descriptor) throw new Error("Routine host descriptor is missing");
  if (!store.claim(id)) return;
  const priorStop = store.stopReason(id);
  if (priorStop) {
    store.finish(id, { status: "interrupted", note: priorStop, finishedAt: Date.now(), worktreePath: descriptor.worktreePath });
    return;
  }
  const execution = runRoutineScript(descriptor.cwd, descriptor.script, descriptor.worktreePath, true);
  const stop = () => execution.stop("interrupted by host shutdown");
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const timer = setInterval(() => {
    try { const reason = store.stopReason(id); if (reason) execution.stop(reason); }
    catch { execution.stop("interrupted by unavailable host storage"); }
  }, 100);
  try {
    ready();
    const result = await execution.done;
    // Keep the completed result in memory and retain ownership while storage is unavailable.
    for (;;) {
      try { store.finish(id, result); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
    }
  } finally {
    clearInterval(timer);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}
