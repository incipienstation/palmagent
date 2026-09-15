import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync, renameSync, openSync, closeSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionRecord, ExecutionStore } from "./store.js";

export type ExecutionLauncher = (record: ExecutionRecord) => void;
export function launchExecution(record: ExecutionRecord): void {
  const result = spawnSync("sudo", ["-n", "/usr/local/libexec/palmagent-execution-start", record.id], { encoding: "utf8", timeout: 10_000 });
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
export function admitExecutions(store: ExecutionStore, limit: number, launch: ExecutionLauncher = launchExecution): void {
  store.admit(limit);
  for (const record of store.list()) {
    if (record.state !== "starting" || record.pid !== null) { attempted.delete(record.id); continue; }
    if (Date.now() - (attempted.get(record.id) ?? 0) < 5000) continue;
    attempted.set(record.id, Date.now());
    // A launch uncertainty is never reset to queued. Unit identity plus the
    // host's durable claim prevent a repeated invocation during reconciliation.
    try { prepareLaunch(store, record); launch(record); }
    catch { /* Keep the reservation for operator reconciliation, not a duplicate launch. */ }
  }
}
