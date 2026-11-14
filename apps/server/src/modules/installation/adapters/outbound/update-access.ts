import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { UpdateDiscoverySchema, UpdateRequestSchema } from "@palmagent/shared/updates";
import { ensurePrivateParent } from "../../../../platform/filesystem/private-files.js";
import type { InstallConfig } from "../../domain/installation.js";
import type { UpdateAccessState as AccessState } from "../../domain/update-access.js";
const AccessStateSchema = z.object({ discovery: UpdateDiscoverySchema.nullable(), pending: UpdateRequestSchema.nullable() });
export const updateAccessFile = "update-access.json";

export function readUpdateAccess(dataDir: string): AccessState {
  try { return AccessStateSchema.parse(JSON.parse(readFileSync(join(dataDir, updateAccessFile), "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { discovery: null, pending: null };
    throw new Error("cannot read update availability");
  }
}

/** The caller holds the shared host lock for every read/modify/write. */
export function writeUpdateAccess(dataDir: string, state: AccessState): void {
  ensurePrivateParent(dataDir);
  const path = join(dataDir, updateAccessFile);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(AccessStateSchema.parse(state)) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  try {
    renameSync(temporary, path);
    const directory = openSync(dataDir, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}

export function packageVersion(cfg: InstallConfig): string {
  return JSON.parse(readFileSync(join(cfg.pkgDir!, "package.json"), "utf8")).version;
}
