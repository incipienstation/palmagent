import { existsSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { userInfo } from "node:os";
import type { UpdateSettingsState } from "@palmagent/shared/updates";
import type { UpdateAccessStore, UpdateDiscoveryHost, UpdateSettingsHost } from "../../application/ports/outbound/update-settings.js";
import { readUpdateAccess, writeUpdateAccess, packageVersion } from "./update-access.js";
import { prepareUpdateService, startRequestedUpdate, retireAutoUpdateTimer, configureAutoUpdate } from "./auto-update.js";
import { callerPkgDir, installEnvPath, loadConfig, type InstallConfig } from "./config.js";
import { getUserConfig, setUserChannel, userConfigPath } from "./user-config.js";
import { acquireUpdateLock, readUpdateReceipt, UpdateBusyError } from "./update-state.js";
import { installedDistribution } from "./standalone-release.js";
import { canSudoNonInteractive } from "./sh.js";
import { discoverPlugins } from "./plugin-update.js";
import { resolveUpdatePlan } from "./update-plan.js";
import { UpdateDiscoveryError } from "./update-discovery-error.js";

export const updateAccessStore: UpdateAccessStore = { read: readUpdateAccess, write: writeUpdateAccess, receipt: readUpdateReceipt };
export const updateDiscoveryHost: UpdateDiscoveryHost = {
  preferences: dataDir => getUserConfig({ dataDir }), version: packageVersion, distribution: installedDistribution,
  now: () => Date.now(), requestId: randomUUID,
  discover(config, current, channel, distribution) {
    try { return { ok: true, plan: resolveUpdatePlan(current, channel, discoverPlugins(config), undefined, { installation: config, distribution }) }; }
    catch (error) { return { ok: false, failure: error instanceof UpdateDiscoveryError ? error.failure : { source: "unknown", code: "unknown" } }; }
  },
};

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
  return { cfg, availability: owner && process.platform === "linux" && (cfg.supervisor === "palmagentd" || canSudoNonInteractive()) ? "available" : "permission-required" };
}

export function createUpdateSettingsHost(legacyTasksIdle: UpdateSettingsHost["legacyTasksIdle"]): UpdateSettingsHost {
  return {
    lock() { try { return acquireUpdateLock(dirname(userConfigPath())); } catch (error) { if (error instanceof UpdateBusyError) return undefined; throw error; } },
    installation, legacyTasksIdle,
    setChannel: (config, channel, dryRun) => { setUserChannel(channel, { dataDir: config.dataDir, dryRun }); },
    configureAutomatic: configureAutoUpdate, retireTimer: retireAutoUpdateTimer,
    prepare: prepareUpdateService, start: startRequestedUpdate,
  };
}
