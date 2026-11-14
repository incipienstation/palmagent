import type { Distribution } from "@palmagent/shared/standalone";
import type { UpdateRequest } from "@palmagent/shared/updates";
import type { InstallConfig } from "../../domain/installation.js";
import { CHECK_CACHE_MS, FAILED_CHECK_CACHE_MS, type UpdateAccessState } from "../../domain/update-access.js";
import type { UpdateAccessUseCases } from "../ports/inbound/update-settings-command.js";
import type { UpdateAccessStore, UpdateDiscoveryHost } from "../ports/outbound/update-settings.js";

export function createUpdateAccess(store: UpdateAccessStore, host: UpdateDiscoveryHost): UpdateAccessUseCases {
  function checkUpdateAccess(cfg: InstallConfig, force: boolean, now = host.now(), distribution?: Distribution): UpdateAccessState {
    const state = store.read(cfg.dataDir);
    const { channel } = host.preferences(cfg.dataDir);
    const currentVersion = host.version(cfg);
    const targetDistribution = distribution ?? (channel === "preview" ? "standalone" : host.distribution(cfg));
    const cached = state.discovery;
    const cachedDistribution = cached?.distribution ?? (cached?.selection ? "standalone" : targetDistribution);
    const age = cached ? now - Date.parse(cached.checkedAt) : Infinity;
    if (!force && cachedDistribution === targetDistribution && cached?.channel === channel && cached.currentVersion === currentVersion && (cached.error || cached.pluginsPending !== undefined) && age >= 0 && age < (cached.error ? FAILED_CHECK_CACHE_MS : CHECK_CACHE_MS)) return state;
    const discovered = host.discover(cfg, currentVersion, channel, distribution);
    if (discovered.ok) {
      const plan = discovered.plan;
      state.discovery = { distribution: targetDistribution, channel, currentVersion, targetVersion: plan.targetVersion,
        eligible: plan.automaticEligible, pluginsPending: plan.plugins.filter((p) => p.action === "update").length,
        packagePending: plan.packageAction === "update", ...(plan.selection ? { selection: plan.selection } : {}),
        checkedAt: new Date(now).toISOString(), error: false };
    } else {
      // Throttle reconnect storms, but let the next visit recover promptly from a
      // transient failure. Old clients still understand the error boolean.
      state.discovery = { distribution: targetDistribution, channel, currentVersion, targetVersion: null,
        eligible: false, checkedAt: new Date(now).toISOString(), error: true,
        failure: discovered.failure };
    }
    store.write(cfg.dataDir, state);
    return state;
  }

  function updatePaused(cfg: InstallConfig): boolean {
    const receipt = store.receipt(cfg.dataDir);
    return receipt?.status === "failed" || receipt?.status === "applying";
  }

  function requestUpdateAccess(cfg: InstallConfig, automatic: boolean, version?: string): void {
    if (updatePaused(cfg)) throw new Error("update requires recovery");
    const state = store.read(cfg.dataDir);
    const check = state.discovery;
    const preferences = host.preferences(cfg.dataDir);
    const requiresMigration = preferences.channel === "stable" && host.distribution(cfg) === "npm" && Boolean(check?.selection);
    if (!check || check.error || !check.eligible || !check.targetVersion || (check.targetVersion === check.currentVersion && !check.pluginsPending && !check.packagePending) ||
        check.channel !== preferences.channel || check.currentVersion !== host.version(cfg) ||
        (automatic && (!preferences.autoUpdate || requiresMigration)) || (version !== undefined && version !== check.targetVersion)) {
      throw new Error("check for updates again");
    }
    if (state.pending && automatic) return;
    if (state.pending?.targetVersion === check.targetVersion && state.pending.channel === check.channel && !state.pending.automatic) return;
    state.pending = { id: host.requestId(), channel: check.channel, currentVersion: check.currentVersion,
      targetVersion: check.targetVersion, automatic, ...(check.selection ? { selection: check.selection } : {}) };
    store.write(cfg.dataDir, state);
  }

  function validUpdateRequest(cfg: InstallConfig, request: UpdateRequest): boolean {
    const preferences = host.preferences(cfg.dataDir);
    return store.read(cfg.dataDir).pending?.id === request.id && preferences.channel === request.channel &&
      (!request.automatic || preferences.autoUpdate === true) && host.version(cfg) === request.currentVersion;
  }

  function clearUpdateRequest(cfg: InstallConfig, id?: string): void {
    const state = store.read(cfg.dataDir);
    if (!state.pending || (id && state.pending.id !== id)) return;
    store.write(cfg.dataDir, { ...state, pending: null });
  }

  return { check: checkUpdateAccess, request: requestUpdateAccess, valid: validUpdateRequest, clear: clearUpdateRequest, paused: updatePaused };
}
