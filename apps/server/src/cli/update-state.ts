import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { UpdateReceiptSchema, type UpdateReceipt } from "@palmagent/shared/updates";
import { ensurePrivateParent } from "../private-files.js";
export { acquireUpdateLock, UpdateBusyError } from "../update-lock.js";

export type { UpdateReceipt } from "@palmagent/shared";

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
