// Shared controller for the operator CLI and the web service's bounded CLI bridge.
// It changes preferences/scheduling only; package installation stays in the updater.
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { userInfo } from "node:os";
import { parseArgs } from "node:util";
import { UpdateSettingsChangeSchema, type UpdateSettingsChange, type UpdateSettingsCommandResult, type UpdateSettingsState } from "@palmagent/shared/updates";
import { autoUpdateTimer, configureAutoUpdate } from "./auto-update.js";
import { callerPkgDir, installEnvPath, loadConfig, type InstallConfig } from "./config.js";
import { getUserConfig, setUserChannel, userConfigPath } from "./user-config.js";
import { acquireUpdateLock, readUpdateReceipt, UpdateBusyError } from "./update-state.js";
import { canSudoNonInteractive, run } from "./sh.js";

export function readUpdateSettings(cfg: InstallConfig): NonNullable<UpdateSettingsState["settings"]> {
  const preferences = getUserConfig({ dataDir: cfg.dataDir });
  return {
    channel: preferences.channel,
    autoUpdate: preferences.autoUpdate ?? false,
    timerActive: run("systemctl", ["is-active", autoUpdateTimer], { timeout: 5000 }).ok,
    lastUpdate: readUpdateReceipt(cfg.dataDir) ?? null,
  };
}

/** Keep the existing CLI status shape for installed operator plugins. */
export function autoUpdateStatus(cfg: InstallConfig) {
  const { autoUpdate, ...status } = readUpdateSettings(cfg);
  return { enabled: autoUpdate, ...status };
}

/** The caller holds the shared installation/update lock for a real mutation. */
export function applyUpdateSettings(cfg: InstallConfig, input: UpdateSettingsChange, dryRun = false): void {
  const change = UpdateSettingsChangeSchema.parse(input);
  if ("channel" in change) setUserChannel(change.channel, { dataDir: cfg.dataDir, dryRun });
  else configureAutoUpdate(cfg, change.autoUpdate, dryRun);
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

export function runUpdateSettingsCommand(args: string[]): UpdateSettingsCommandResult {
  let unlock: (() => void) | undefined;
  let changing = false;
  try {
    const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {
      "data-dir": { type: "string" }, "expected-db": { type: "string" },
      channel: { type: "string" }, "auto-update": { type: "string" },
    } });
    if (positionals.length !== 1 || !["status", "set"].includes(positionals[0]) || !values["data-dir"] || !values["expected-db"]) {
      throw new Error("invalid update settings command");
    }
    changing = positionals[0] === "set";
    let change: UpdateSettingsChange | undefined;
    if (changing) {
      change = UpdateSettingsChangeSchema.parse({
        ...(values.channel !== undefined ? { channel: values.channel } : {}),
        ...(values["auto-update"] !== undefined ? { autoUpdate: values["auto-update"] === "true" ? true : values["auto-update"] === "false" ? false : values["auto-update"] } : {}),
      });
      unlock = acquireUpdateLock(dirname(userConfigPath()));
    } else if (values.channel !== undefined || values["auto-update"] !== undefined) throw new Error("status cannot change preferences");
    const { cfg, availability } = installation(values["data-dir"], values["expected-db"]);
    if (change && (availability !== "available" || !cfg)) return { ok: false, error: "unavailable" };
    if (cfg && change) applyUpdateSettings(cfg, change);
    return { ok: true, state: { availability, settings: cfg ? readUpdateSettings(cfg) : null } };
  } catch (error) {
    // Installation/parser/subprocess errors may contain private paths or config
    // values. The bridge exposes only these stable, public error categories.
    return { ok: false, error: error instanceof UpdateBusyError ? "busy" : changing ? "save-failed" : "unavailable" };
  } finally { unlock?.(); }
}
