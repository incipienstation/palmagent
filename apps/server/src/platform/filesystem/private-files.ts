import { chmodSync, mkdirSync, openSync, closeSync, fsyncSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** Persistent Palmagent state contains bearer sessions and must be user-private. */
export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/** Create a file's parent privately when absent without changing permissions on
 * an explicitly overridden, pre-existing parent such as /tmp or a mounted path. */
export function ensurePrivateParent(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/** Tighten an existing or newly-created state file to owner read/write only. */
export function ensurePrivateFile(path: string): void {
  chmodSync(path, 0o600);
}

/** Commit one private record without exposing a truncated activation decision. */
export function writePrivateFileAtomic(path: string, content: string | Uint8Array): void {
  ensurePrivateParent(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
