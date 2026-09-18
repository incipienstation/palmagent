import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ExecutionIdSchema, EXECUTION_PROTOCOL, type ExecutionCommandResult } from "@palmagent/shared/executions";
import { ExecutionStore } from "./execution/store.js";
import { admitExecutions } from "./execution/launch.js";
import { watchExecutions } from "./execution/wake.js";
import { getRunner } from "./runner.js";
import { InProcessBackend } from "./inproc-backend.js";
import type { RunHandle } from "./types.js";

const directory = process.argv[2];
const id = ExecutionIdSchema.parse(process.argv[3]);
if (!directory) throw new Error("Execution state directory is required");
const store = new ExecutionStore(resolve(directory));
const record = store.get(id);
const descriptor = JSON.parse(readFileSync(join(directory, `${id}.json`), "utf8"));
if (record.protocol !== EXECUTION_PROTOCOL || descriptor.release !== record.release || descriptor.node !== record.node) throw new Error("Execution launch identity mismatch");
if (!store.claim(id)) { store.close(); process.exit(0); }
const backend = new InProcessBackend();
let handle: RunHandle | undefined;
let stopping = false;
let busy = false;
let dispose = () => {};
let sessionId = record.args.resumeId;
let identityMismatch = false;
const emit: Parameters<ReturnType<typeof getRunner>["start"]>[1] = (event) => {
  if (stopping || identityMismatch) return;
  if (event.sessionId && sessionId && event.sessionId !== sessionId) {
    identityMismatch = true;
    store.append(id, { taskId: record.taskId, sessionId, kind: "error", payload: { message: "Provider session identity changed; the invocation was stopped" } });
    store.append(id, { taskId: record.taskId, kind: "status", payload: { subtype: "process_exit", code: -1 } });
    queueMicrotask(() => handle?.cancel());
    return;
  }
  if (!sessionId && event.sessionId) {
    try { store.bindSession(id, event.sessionId); }
    catch {
      identityMismatch = true;
      store.append(id, { taskId: record.taskId, kind: "error", payload: { message: "Provider session is already owned; the invocation was stopped" } });
      store.append(id, { taskId: record.taskId, kind: "status", payload: { subtype: "process_exit", code: -1 } });
      queueMicrotask(() => handle?.cancel());
      return;
    }
  }
  sessionId ??= event.sessionId;
  store.append(id, event);
};

async function drain() {
  if (busy || stopping || !handle) return;
  busy = true;
  try {
    for (const command of store.pending(id)) {
      let result: ExecutionCommandResult = "unknown";
      try {
        const body = command.body;
        let accepted = false;
        switch (body.kind) {
          case "send": result = await handle.send?.(body.text, body.images, body.messageId) ?? "rejected"; break;
          case "steer": accepted = handle.steer(body.text, body.images); break;
          case "answer": accepted = await handle.answer(body.answer); break;
          case "approve": accepted = handle.approve(body.decision, body.scope); break;
          case "interrupt": accepted = handle.interrupt(); if (!accepted) { handle.cancel(); accepted = true; } break;
          case "cancel": handle.cancel(); accepted = true; break;
        }
        if (body.kind !== "send") result = accepted ? "delivered" : "rejected";
      } catch { /* Sending to a provider and persisting its receipt cannot be atomic. */ }
      if (stopping) return;
      store.settle(id, command.id, result);
    }
  } finally { busy = false; }
}
async function finish(lost = false) {
  if (stopping) return;
  stopping = true;
  dispose();
  store.finish(id, lost);
  // Existing children have already exited. Never close an active backend as an
  // application-update side effect; this process belongs to its execution unit.
  await backend.close();
  const limit = Number(process.env.PALMAGENT_EXECUTION_CONCURRENCY || 8);
  if (Number.isSafeInteger(limit) && limit > 0) admitExecutions(store, limit);
  store.close();
  setImmediate(() => process.exit(lost ? 1 : 0));
}
try {
  emit({ taskId: record.taskId, kind: "status", payload: { subtype: "execution_started" } });
  handle = getRunner(record.args.agent).start(record.args, emit, backend);
  dispose = watchExecutions(store.directory, () => { void drain(); });
  void drain();
  handle.done.then(() => finish(), () => finish(true));
} catch {
  emit({ taskId: record.taskId, kind: "error", payload: { message: "Execution host could not start the provider" } });
  void finish(true);
}
