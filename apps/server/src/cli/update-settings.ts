// Shared controller for the operator CLI and the web service's bounded CLI bridge.
// Availability and requests are durable; package installation stays in the updater.
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { userInfo } from "node:os";
import { parseArgs } from "node:util";
import { UpdateSettingsChangeSchema, type UpdateSettingsChange, type UpdateSettingsCommandResult, type UpdateSettingsState } from "@palmagent/shared/updates";
import Database from "better-sqlite3";
import { readUpdateAccess, checkUpdateAccess, clearUpdateRequest, requestUpdateAccess, validUpdateRequest, updatePaused } from "./update-access.js";
import { prepareUpdateService, startRequestedUpdate, retireAutoUpdateTimer, configureAutoUpdate } from "./auto-update.js";
import { callerPkgDir, installEnvPath, loadConfig, type InstallConfig } from "./config.js";
import { getUserConfig, setUserChannel, userConfigPath } from "./user-config.js";
import { acquireUpdateLock, readUpdateReceipt, UpdateBusyError } from "./update-state.js";
import { canSudoNonInteractive } from "./sh.js";

export function readUpdateSettings(cfg: InstallConfig): NonNullable<UpdateSettingsState["settings"]> {
  const preferences = getUserConfig({ dataDir: cfg.dataDir });
  const access = readUpdateAccess(cfg.dataDir);
  if (access.discovery?.channel !== preferences.channel) access.discovery = null;
  if (access.pending && (access.pending.channel !== preferences.channel || (access.pending.automatic && !preferences.autoUpdate))) access.pending = null;
  return {
    channel: preferences.channel,
    autoUpdate: preferences.autoUpdate ?? false,
    independentExecutions: Boolean(cfg.executionNode),
    ...access,
    lastUpdate: readUpdateReceipt(cfg.dataDir) ?? null,
  };
}

/** Keep the CLI enabled flag while sharing availability and pending state. */
export function autoUpdateStatus(cfg: InstallConfig) {
  const { autoUpdate, ...status } = readUpdateSettings(cfg);
  return { enabled: autoUpdate, ...status };
}

/** The caller holds the shared installation/update lock for a real mutation. */
export function applyUpdateSettings(cfg: InstallConfig, input: UpdateSettingsChange, dryRun = false): void {
  const change = UpdateSettingsChangeSchema.parse(input);
  if ("channel" in change) setUserChannel(change.channel, { dataDir: cfg.dataDir, dryRun });
  else configureAutoUpdate(cfg, change.autoUpdate, dryRun);
  if (!dryRun && ("channel" in change || readUpdateAccess(cfg.dataDir).pending?.automatic)) clearUpdateRequest(cfg);
}

function installation(dataDir: string, expectedDb: string): { cfg?: InstallConfig; availability: UpdateSettingsState["availability"] } {
  if (!existsSync(installEnvPath(dataDir))) return { availability: "not-installed" };
  const cfg = loadConfig({ dataDir, requireInstalled: true });
  if (cfg.mode !== "package") return { availability: "source-install" };
  // The web service may manage only its own package and DB, even when another
  // installation's metadata is present under the same account.
  if (!cfg.pkgDir || realpathSync(cfg.pkgDir) !== realpathSync(callerPkgDir()) || resolve(cfg.dbPath) !== resolve(expectedDb)) {
    return { availability: "installation-mismatch" };
  }
  const owner = cfg.user !== "root" && cfg.user === userInfo().username;
  return { cfg, availability: owner && process.platform === "linux" && canSudoNonInteractive() ? "available" : "permission-required" };
}

export function runUpdateSettingsCommand(args: string[], checkAvailability = checkUpdateAccess): UpdateSettingsCommandResult {
  let unlock: (() => void) | undefined;
  let changing = false;
  let action = "status";
  try {
    const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {
      "data-dir": { type: "string" }, "expected-db": { type: "string" },
      channel: { type: "string" }, "auto-update": { type: "string" }, target: { type: "string" },
    } });
    if (positionals.length !== 1 || !["status", "set", "visit", "check", "install", "resume"].includes(positionals[0]) || !values["data-dir"] || !values["expected-db"]) {
      throw new Error("invalid update settings command");
    }
    action = positionals[0];
    changing = action !== "status";
    if ((action === "install") !== (values.target !== undefined)) throw new Error("invalid update target");
    let change: UpdateSettingsChange | undefined;
    if (action === "set") {
      change = UpdateSettingsChangeSchema.parse({
        ...(values.channel !== undefined ? { channel: values.channel } : {}),
        ...(values["auto-update"] !== undefined ? { autoUpdate: values["auto-update"] === "true" ? true : values["auto-update"] === "false" ? false : values["auto-update"] } : {}),
      });
    } else if (values.channel !== undefined || values["auto-update"] !== undefined) throw new Error("status cannot change preferences");
    if (changing) unlock = acquireUpdateLock(dirname(userConfigPath()));
    const { cfg, availability } = installation(values["data-dir"], values["expected-db"]);
    if (changing && (availability !== "available" || !cfg)) return { ok: false, error: "unavailable" };
    if (cfg && changing) {
      if (change) applyUpdateSettings(cfg, change);
      retireAutoUpdateTimer();
      const check = action === "visit" || action === "check" || (change && ("channel" in change || change.autoUpdate));
      if (check) {
        const state = checkAvailability(cfg, action !== "visit");
        // Changing channel only checks availability; installation needs a later
        // visit or an explicit Update action in the newly selected channel.
        if (!(change && "channel" in change) && state.discovery?.eligible &&
            state.discovery.targetVersion !== state.discovery.currentVersion &&
            getUserConfig({ dataDir: cfg.dataDir }).autoUpdate && !updatePaused(cfg)) {
          requestUpdateAccess(cfg, true);
        }
      }
      if (action === "install") {
        try { requestUpdateAccess(cfg, false, values.target); }
        catch { return { ok: false, error: "stale-update" }; }
      }
      const pending = readUpdateAccess(cfg.dataDir).pending;
      if (pending && !validUpdateRequest(cfg, pending)) clearUpdateRequest(cfg, pending.id);
      else if (pending && !updatePaused(cfg)) {
        let ready = Boolean(cfg.executionNode);
        if (!ready) {
          const db = new Database(cfg.dbPath, { readonly: true, fileMustExist: true });
          try { ready = (db.prepare("SELECT count(*) AS count FROM tasks WHERE status IN ('running','awaiting_approval','awaiting_input','queued')").get() as { count: number }).count === 0; }
          finally { db.close(); }
        }
        if (ready) {
          prepareUpdateService(cfg);
          // The executor also takes this lock; release before asking systemd to start it.
          unlock?.(); unlock = undefined;
          startRequestedUpdate();
        }
      }
    }
    return { ok: true, state: { availability, settings: cfg ? readUpdateSettings(cfg) : null } };
  } catch (error) {
    // Installation/parser/subprocess errors may contain private paths or config
    // values. The bridge exposes only these stable, public error categories.
    return { ok: false, error: error instanceof UpdateBusyError ? "busy" : action === "set" ? "save-failed" : changing ? "update-failed" : "unavailable" };
  } finally { unlock?.(); }
}
