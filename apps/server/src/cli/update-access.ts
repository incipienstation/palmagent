import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { UpdateDiscoverySchema, UpdateRequestSchema, type UpdateRequest } from "@palmagent/shared/updates";
import { ensurePrivateParent } from "../private-files.js";
import type { InstallConfig } from "./config.js";
import { getUserConfig } from "./user-config.js";
import { resolveUpdatePlan } from "./update-plan.js";
import { readUpdateReceipt } from "./update-state.js";

const AccessStateSchema = z.object({
  discovery: UpdateDiscoverySchema.nullable(), pending: UpdateRequestSchema.nullable(),
});
type AccessState = z.infer<typeof AccessStateSchema>;
export const updateAccessFile = "update-access.json";
// This is a cache lifetime, never a scheduled wake-up.
const CHECK_CACHE_MS = 15 * 60 * 1000;

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

export function checkUpdateAccess(cfg: InstallConfig, force: boolean, now = Date.now()): AccessState {
  const state = readUpdateAccess(cfg.dataDir);
  const { channel } = getUserConfig({ dataDir: cfg.dataDir });
  const currentVersion = packageVersion(cfg);
  const cached = state.discovery;
  const age = cached ? now - Date.parse(cached.checkedAt) : Infinity;
  if (!force && cached?.channel === channel && cached.currentVersion === currentVersion && age >= 0 && age < CHECK_CACHE_MS) return state;
  try {
    const plan = resolveUpdatePlan(currentVersion, channel, []);
    state.discovery = { channel, currentVersion, targetVersion: plan.targetVersion,
      eligible: plan.automaticEligible, checkedAt: new Date(now).toISOString(), error: false };
  } catch {
    // Cache failures too, so reconnect storms cannot hammer the registry.
    state.discovery = { channel, currentVersion, targetVersion: null,
      eligible: false, checkedAt: new Date(now).toISOString(), error: true };
  }
  writeUpdateAccess(cfg.dataDir, state);
  return state;
}

export function updatePaused(cfg: InstallConfig): boolean {
  const receipt = readUpdateReceipt(cfg.dataDir);
  return receipt?.status === "failed" || receipt?.status === "applying";
}

export function requestUpdateAccess(cfg: InstallConfig, automatic: boolean, version?: string): void {
  if (updatePaused(cfg)) throw new Error("update requires recovery");
  const state = readUpdateAccess(cfg.dataDir);
  const check = state.discovery;
  const preferences = getUserConfig({ dataDir: cfg.dataDir });
  if (!check || check.error || !check.eligible || !check.targetVersion || check.targetVersion === check.currentVersion ||
      check.channel !== preferences.channel || check.currentVersion !== packageVersion(cfg) ||
      (automatic && !preferences.autoUpdate) || (version !== undefined && version !== check.targetVersion)) {
    throw new Error("check for updates again");
  }
  if (state.pending && automatic) return;
  if (state.pending?.targetVersion === check.targetVersion && state.pending.channel === check.channel && !state.pending.automatic) return;
  state.pending = { id: randomUUID(), channel: check.channel, currentVersion: check.currentVersion,
    targetVersion: check.targetVersion, automatic };
  writeUpdateAccess(cfg.dataDir, state);
}

export function validUpdateRequest(cfg: InstallConfig, request: UpdateRequest): boolean {
  const preferences = getUserConfig({ dataDir: cfg.dataDir });
  return readUpdateAccess(cfg.dataDir).pending?.id === request.id && preferences.channel === request.channel &&
    (!request.automatic || preferences.autoUpdate === true) && packageVersion(cfg) === request.currentVersion;
}

export function clearUpdateRequest(cfg: InstallConfig, id?: string): void {
  const state = readUpdateAccess(cfg.dataDir);
  if (!state.pending || (id && state.pending.id !== id)) return;
  writeUpdateAccess(cfg.dataDir, { ...state, pending: null });
}
