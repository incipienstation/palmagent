import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ExecutionIdSchema, EXECUTION_PROTOCOL } from "@palmagent/shared/executions";
import { drainExecutionCommands } from "../modules/agents/adapters/outbound/execution-commands.js";
import { ExecutionPersistence } from "../modules/agents/adapters/outbound/execution-persistence.js";
import { ExecutionStore } from "../modules/agents/adapters/outbound/execution-store.js";
import { admitExecutions } from "../modules/agents/adapters/outbound/execution-launch.js";
import { watchExecutions } from "../modules/agents/adapters/outbound/execution-wake.js";
import { getRunner } from "../modules/agents/adapters/outbound/runner.js";
import { InProcessBackend } from "../modules/agents/adapters/outbound/inproc-backend.js";
import type { RunHandle } from "../modules/agents/domain/run-handle.js";
import type { RawEvent } from "../modules/agents/domain/execution.js";

const directory = process.argv[2];
const id = ExecutionIdSchema.parse(process.argv[3]);
if (!directory) throw new Error("Execution state directory is required");
const store = new ExecutionStore(resolve(directory));
const record = store.get(id);
const descriptor = JSON.parse(readFileSync(join(directory, `${id}.json`), "utf8"));
if (record.protocol !== EXECUTION_PROTOCOL || descriptor.release !== record.release || descriptor.node !== record.node) throw new Error("Execution launch identity mismatch");
// Short synchronous attempts plus asynchronous retry keep provider pipes responsive.
store.db.pragma("busy_timeout = 50");
const persistence = new ExecutionPersistence();
if (!await persistence.run("claim", () => store.claim(id))) { persistence.close(); store.close(); process.exit(0); }
const backend = new InProcessBackend();
let handle: RunHandle | undefined;
let stopping = false;
let busy = false;
let dispose = () => {};
let sessionId = record.args.resumeId;
let identityMismatch = false;
const persistEvent = (event: RawEvent): boolean => {
  if (identityMismatch) return false;
  if (event.sessionId && sessionId && event.sessionId !== sessionId) {
    store.append(id, { taskId: record.taskId, sessionId, kind: "error", payload: { message: "Provider session identity changed; the invocation was stopped" } });
    store.append(id, { taskId: record.taskId, kind: "status", payload: { subtype: "process_exit", code: -1 } });
    return true;
  }
  if (!sessionId && event.sessionId) {
    try { store.bindSession(id, event.sessionId); }
    catch (error) {
      if ((error as { code?: string }).code !== "SQLITE_CONSTRAINT_UNIQUE") throw error;
      store.append(id, { taskId: record.taskId, kind: "error", payload: { message: "Provider session is already owned; the invocation was stopped" } });
      store.append(id, { taskId: record.taskId, kind: "status", payload: { subtype: "process_exit", code: -1 } });
      return true;
    }
  }
  store.append(id, event);
  return false;
};
let failed = false;
function fatal(error: unknown) {
  if (failed) return;
  failed = true;
  stopping = true;
  dispose();
  persistence.close();
  console.error(JSON.stringify({ event: "execution_store_failed", code: (error as { code?: string })?.code ?? "UNKNOWN" }));
  // Leave durable ownership and uncertain receipts for reconciliation. Never
  // invent successful delivery or silently drop an event after storage failure.
  void backend.close().finally(() => process.exit(1));
}
const emit: Parameters<ReturnType<typeof getRunner>["start"]>[1] = (event) => {
  if (stopping || identityMismatch) return;
  void persistence.run("event", () => {
    const mismatch = store.db.transaction(() => persistEvent(event)).immediate();
    if (mismatch) { identityMismatch = true; handle?.cancel(); }
    else sessionId ??= event.sessionId;
  }).catch(fatal);
};

async function drain() {
  if (busy || stopping || !handle) return;
  busy = true;
  try {
    await drainExecutionCommands(store, persistence, id, handle, () => stopping);
  } finally { busy = false; }
}
async function finish(lost = false) {
  if (stopping) return;
  stopping = true;
  dispose();
  // This joins the ordered persistence queue, including the provider's final output.
  await persistence.run("finish", () => store.finish(id, lost));
  // Existing children have already exited. Never close an active backend as an
  // application-update side effect; this process belongs to its execution unit.
  await backend.close();
  const limit = Number(process.env.PALMAGENT_EXECUTION_CONCURRENCY || 8);
  if (Number.isSafeInteger(limit) && limit > 0) await persistence.run("admit", () => admitExecutions(store, limit));
  persistence.close();
  store.close();
  setImmediate(() => process.exit(lost ? 1 : 0));
}
try {
  emit({ taskId: record.taskId, kind: "status", payload: { subtype: "execution_started" } });
  handle = getRunner(record.args.agent).start({ ...record.args, skills: record.skills }, emit, backend);
  dispose = watchExecutions(store.directory, () => { void drain().catch(fatal); }, id);
  void drain().catch(fatal);
  void handle.done.then(() => finish(), () => finish(true)).catch(fatal);
} catch {
  emit({ taskId: record.taskId, kind: "error", payload: { message: "Execution host could not start the provider" } });
  void finish(true).catch(fatal);
}
