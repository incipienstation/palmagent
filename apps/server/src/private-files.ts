import { chmodSync, mkdirSync } from "node:fs";

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
