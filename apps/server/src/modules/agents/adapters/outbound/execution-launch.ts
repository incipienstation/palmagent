import { HOST_ARTIFACTS } from "../../../../platform/process/host-artifacts.js";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync, renameSync, openSync, closeSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionRecord, ExecutionStore } from "./execution-store.js";
import { daemonRequest } from "../../../../platform/process/daemon-client.js";

export type ExecutionLauncher = (record: ExecutionRecord) => void | Promise<void>;
export function launchExecution(record: ExecutionRecord): void | Promise<void> {
  if (process.env.PALMAGENT_DAEMON_DATA) {
    return daemonRequest(process.env.PALMAGENT_DAEMON_DATA, { action: "launch", kind: "execution", id: record.id }).then(() => {});
  }
  const result = spawnSync("sudo", ["-n", HOST_ARTIFACTS.execution.helperPath, record.id], { encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) throw new Error("Execution launch could not be confirmed; the invocation remains reserved");
}
export function prepareLaunch(store: ExecutionStore, record: ExecutionRecord): void {
  const path = join(store.directory, `${record.id}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ protocol: record.protocol, id: record.id, directory: store.directory,
    node: record.node, release: record.release }) + "\n", { mode: 0o600 });
  const fd = openSync(temporary, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(store.directory, "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
const attempted = new Map<string, number>();
const launching = new Set<string>();
export function admitExecutions(store: ExecutionStore, limit: number, launch: ExecutionLauncher = launchExecution): void {
  store.admit(limit);
  for (const record of store.list()) {
    if (record.state !== "starting" || record.pid !== null) { attempted.delete(record.id); continue; }
    if (launching.has(record.id) || Date.now() - (attempted.get(record.id) ?? 0) < 5000) continue;
    attempted.set(record.id, Date.now());
    // A launch uncertainty is never reset to queued. Unit identity plus the
    // host's durable claim prevent a repeated invocation during reconciliation.
    try {
      prepareLaunch(store, record);
      const pending = launch(record);
      if (pending) {
        launching.add(record.id);
        void pending.catch(() => {}).finally(() => launching.delete(record.id));
      }
    }
    catch { /* Keep the reservation for operator reconciliation, not a duplicate launch. */ }
  }
}
