import { watch } from "node:fs";

/** File notifications are hints; bounded reconciliation repairs missed wakeups.
 * This observes execution state, never release availability. */
export function watchExecutions(directory: string, reconcile: () => void): () => void {
  let scheduled: NodeJS.Immediate | undefined;
  const wake = () => { scheduled ??= setImmediate(() => { scheduled = undefined; reconcile(); }); };
  const watcher = watch(directory, wake);
  watcher.on("error", wake);
  const repair = setInterval(wake, 1000);
  repair.unref();
  return () => { watcher.close(); clearInterval(repair); if (scheduled) clearImmediate(scheduled); };
}
