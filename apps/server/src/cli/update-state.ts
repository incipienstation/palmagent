import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { UpdateReceiptSchema, type UpdateReceipt } from "@palmagent/shared/updates";
import { ensurePrivateParent } from "../private-files.js";

export type { UpdateReceipt } from "@palmagent/shared";

export class UpdateBusyError extends Error {
  constructor() { super("another Palmagent operation is already running; retry after it finishes"); }
}

export function readUpdateReceipt(dataDir: string): UpdateReceipt | undefined {
  try { return UpdateReceiptSchema.parse(JSON.parse(readFileSync(join(dataDir, "update-result.json"), "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("cannot read the last update result; inspect it before retrying an update");
  }
}

export function writeUpdateReceipt(dataDir: string, receipt: Omit<UpdateReceipt, "schemaVersion" | "checkedAt">): void {
  ensurePrivateParent(dataDir);
  const temporary = join(dataDir, `.update-${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ schemaVersion: 1, ...receipt, checkedAt: new Date().toISOString() }) + "\n");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    renameSync(temporary, join(dataDir, "update-result.json"));
    const directory = openSync(dataDir, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}

/** flock uses the inherited open file description; closing our fd releases it,
 * including when the process crashes. The lock file itself is never deleted. */
export function acquireUpdateLock(dataDir: string): () => void {
  ensurePrivateParent(dataDir);
  const path = join(dataDir, "update.lock");
  try { if (!lstatSync(path).isFile()) throw new Error("update lock must be a regular file"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  const result = spawnSync("flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "75", "3"], {
    stdio: ["ignore", "pipe", "pipe", fd], encoding: "utf8",
  });
  if (result.status !== 0) {
    closeSync(fd);
    throw result.status === 75 ? new UpdateBusyError() : new Error("cannot acquire the update lock; flock is required");
  }
  return () => closeSync(fd);
}
