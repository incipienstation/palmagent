import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export function maintenancePath(dbPath: string): string {
  return join(dirname(dbPath), "update-maintenance.json");
}

function processIdentity(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() + ":" + started;
}

/** A crashed updater must not leave task admission disabled indefinitely. */
export function isUpdateMaintenance(dbPath: string): boolean {
  try {
    const value = JSON.parse(readFileSync(maintenancePath(dbPath), "utf8"));
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 1) return true;
    try {
      process.kill(value.pid, 0);
      return typeof value.identity !== "string" || processIdentity(value.pid) === value.identity;
    }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}

/** The caller holds the installation lock throughout this maintenance window. */
export function beginUpdateMaintenance(dbPath: string): () => void {
  if (isUpdateMaintenance(dbPath)) throw new Error("an update maintenance window is already active");
  const path = maintenancePath(dbPath);
  const token = randomUUID();
  const temporary = `${path}.${token}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, pid: process.pid, identity: processIdentity(process.pid), token }) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  return () => {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value.token !== token) throw new Error("update maintenance ownership changed");
    unlinkSync(path);
  };
}
