import { watch, writeFileSync } from "node:fs";
import { join } from "node:path";

export function notifyExecutionCommands(directory: string, id: string): void {
  // A hint after commit, never an authority or a condition for accepting a command.
  try { writeFileSync(join(directory, `${id}.commands`), "", { mode: 0o600 }); }
  catch { /* Periodic reconciliation also supports older clients without hints. */ }
}

/** File notifications are hints; bounded reconciliation repairs missed wakeups.
 * This observes execution state, never release availability. */
export function watchExecutions(directory: string, reconcile: () => void, commandExecution?: string): () => void {
  let scheduled: NodeJS.Immediate | undefined;
  const wake = () => { scheduled ??= setImmediate(() => { scheduled = undefined; reconcile(); }); };
  const watcher = watch(directory, (_event, filename) => {
    if (!commandExecution || filename === null || filename === `${commandExecution}.commands`) wake();
  });
  watcher.on("error", wake);
  const repair = setInterval(wake, 1000);
  repair.unref();
  return () => { watcher.close(); clearInterval(repair); if (scheduled) clearImmediate(scheduled); };
}
