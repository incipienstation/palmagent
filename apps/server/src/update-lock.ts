import { closeSync, constants, lstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ensurePrivateParent } from "./private-files.js";

export class UpdateBusyError extends Error {
  constructor() { super("another Palmagent operation is already running; retry after it finishes"); }
}

/** Shared host lock used by operator commands and settings storage. */
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
