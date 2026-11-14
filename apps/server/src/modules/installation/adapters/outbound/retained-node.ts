import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDirectory } from "../../../../platform/filesystem/private-files.js";

/** Keep Node in the runtime tree accepted by both current and pre-migration daemons. */
export function pinNode(dataDir: string, executable = process.execPath): string {
  const hash = createHash("sha256").update(readFileSync(executable)).digest("hex");
  const directory = join(dataDir, "runtimes", hash);
  ensurePrivateDirectory(directory);
  const node = join(directory, "node");
  if (!existsSync(node)) { copyFileSync(executable, `${node}.tmp`); chmodSync(`${node}.tmp`, 0o700); renameSync(`${node}.tmp`, node); }
  if (createHash("sha256").update(readFileSync(node)).digest("hex") !== hash) throw new Error("Retained Node runtime integrity mismatch");
  return node;
}
