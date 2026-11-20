import { join } from "node:path";
import { SqliteAdmissionInbox } from "../modules/tasks/adapters/outbound/sqlite-admission.js";
import { drainAdmission } from "../modules/tasks/application/use-cases/drain-admission.js";
import type { TaskUseCases } from "../modules/tasks/api.js";
import { isHandoffWindow } from "../modules/installation/adapters/outbound/update-maintenance.js";

export function startTaskAdmission(dataDir: string, dbPath: string, service: TaskUseCases) {
  const inbox = new SqliteAdmissionInbox(join(dataDir, "update-inbox.sqlite"));
  inbox.acquireOwner();
  let stopped = false;
  let processing: Promise<void> | undefined;
  const drain = () => {
    if (processing || stopped) return;
    processing = drainAdmission(inbox, service, () => stopped).catch(() => {
      console.error("Task admission recovery failed. Pending receipts are retained.");
    }).finally(() => { processing = undefined; });
  };
  const timer = setInterval(drain, 500);
  timer.unref();
  drain();
  return { inbox, deferring: () => isHandoffWindow(dbPath), stop() { stopped = true; }, async close() {
    stopped = true;
    clearInterval(timer);
    await processing;
    inbox.close();
  } };
}
