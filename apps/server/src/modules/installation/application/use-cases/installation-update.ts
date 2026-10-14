import { BRANDING } from "@palmagent/shared";
import type { InstallConfig } from "../../domain/installation.js";
import { channelTag, compatiblePlugin, releaseChannel, validateUpdateTarget } from "../../domain/release-policy.js";
import type { InstallationOptions, InstallationUseCases } from "../ports/inbound/installation-use-cases.js";
import type { InstallationDependencies } from "../ports/outbound/installation.js";
import { verifyIndependentActivation } from "./installation-activation.js";

export function createInstallationUpdate(dependencies: InstallationDependencies,
  lifecycle: Pick<InstallationUseCases, "provisionRuntime"> & { applyInstalledUpdate(config: InstallConfig, options: InstallationOptions): Promise<boolean> }) {
  const { configuration, state, runtime, releases, feedback } = dependencies;
  const { applyInstalledUpdate, provisionRuntime: provisionIndependentRuntime } = lifecycle;
  async function update(options: InstallationOptions): Promise<boolean> {
    const cfg = configuration.load(options.dataDir);
    if (cfg.daemonScope === "user") runtime.assertOwner(cfg);
    cfg.releaseChannel = options.channel !== undefined
      ? releaseChannel(options.channel!)
      : configuration.preferences(cfg.dataDir).channel;
    const explicitVersion = options.targetVersion;
    // Durable requests pin the version discovered on the saved channel; they are
    // not public --to overrides. Request validity is rechecked under the host lock.
    const requestedVersion = options.request?.targetVersion ?? explicitVersion;
    if (requestedVersion !== undefined) {
      if ((!options.pull && !options.plan) || cfg.mode !== "package") {
        throw new Error("--to requires update --pull on a package installation");
      }
      validateUpdateTarget(releases.installedVersion(cfg.pkgDir), requestedVersion, cfg.releaseChannel);
    }
    if ((options.pull || options.plan) && cfg.mode === "source") {
      feedback.err("source checkouts are maintainer-managed and cannot self-update; use the repository build workflow and setup");
      return false;
    }
    let pluginPaths = options.pluginManifests;
    let plugins = releases.readPlugins(pluginPaths);
    if (options.plan) {
      if (options.dryRun || options.automatic) throw new Error("--plan cannot be combined with --dry-run or --automatic");
      feedback.plan(releases.resolvePlan(releases.installedVersion(cfg.pkgDir), cfg.releaseChannel, releases.participatingPlugins(releases.discoverPlugins(cfg), pluginPaths), requestedVersion));
      return true;
    }
    if (options.automatic && (!options.pull || explicitVersion || options.channel)) throw new Error("--automatic requires --pull and follows only the saved channel");
    feedback.step(`${BRANDING.productName} update`);
    feedback.info(`Update channel: ${cfg.releaseChannel === "stable" ? "Stable" : "Preview"} (${channelTag(cfg.releaseChannel)})`);
    if (!options.pull) return applyInstalledUpdate(cfg, options);
    if (options.automatic && !configuration.preferences(cfg.dataDir).autoUpdate) {
      feedback.info("automatic updates are off; nothing changed");
      return true;
    }
    if (options.dryRun) {
      feedback.info(`[dry-run] would resolve ${BRANDING.packageName}@${requestedVersion ?? channelTag(cfg.releaseChannel)}, verify plugin compatibility, install the exact target, and verify runtime health`);
      return true;
    }

    const unlock = state.lock();
    let endMaintenance: (() => void) | undefined;
    let keepRequestedUpdate = false;
    let canRecordRequestError = false;
    try {
      if (options.request && !state.validRequest(cfg, options.request)) return true;
      const previous = state.readUpdate(cfg.dataDir);
      if ((options.automatic || options.request) && (previous?.status === "failed" || previous?.status === "applying")) {
        feedback.warn("automatic updates are paused after an unsuccessful attempt; use the update plugin to inspect and recover");
        return true;
      }
      canRecordRequestError = true;
      const native = releases.discoverPlugins(cfg);
      plugins = releases.participatingPlugins(native, pluginPaths);
      pluginPaths = plugins.map((p) => p.manifest);
      const plan = releases.resolvePlan(releases.installedVersion(cfg.pkgDir), cfg.releaseChannel, plugins, requestedVersion);
      let pluginsUpdated = 0;
      const record = (status: "applying" | "succeeded" | "failed" | "deferred", reason: string) => {
        state.writeUpdate(cfg.dataDir, {
          status, previousVersion: plan.currentVersion, targetVersion: plan.targetVersion, reason,
          ...(pluginsUpdated ? { pluginsUpdated, pluginActivationPending: true } : {}),
        });
        if (status === "succeeded") state.clearDiscovery(cfg.dataDir);
      };
      if (options.automatic && !plan.automaticEligible) {
        record("deferred", "plugin-update-required");
        feedback.info("a plugin-assisted update is needed for the new compatibility line; automatic update deferred");
        return true;
      }
      // Legacy plugins already checked their current CLI's compatibility. Keep
      // their existing --pull call working inside that line; a transition needs
      // explicit installed-manifest evidence from the coordinated update flow.
      if (!plugins.length && !plan.automaticEligible) throw new Error("crossing a compatibility line requires --plugin-manifest for each participating installed plugin; use update --plan first");
      if (plan.plugins.some((plugin) => plugin.action === "update")) {
        // Supplied manifests outside native inventories remain operator-owned.
        if (plan.plugins.some((p) => p.action === "update" && !native.some((n) => n.manifest === p.manifest))) {
          throw new Error("the target needs a matching plugin; refresh it through its native manager and retry");
        }
        record("applying", "plugin-update");
        try {
          const refreshed = releases.refreshPlugins(cfg, plan, native);
          pluginsUpdated = plan.plugins.filter((p) => p.action === "update").length;
          pluginPaths = releases.participatingPlugins(refreshed, pluginPaths.filter((path) => !native.some((p) => p.manifest === releases.canonicalPluginPath(path)))).map((p) => p.manifest);
          feedback.ok(`updated ${pluginsUpdated} operator plugin(s); start a new agent session to load their skills`);
        } catch (error) {
          record("failed", "plugin-update-failed");
          feedback.err(error instanceof Error ? error.message : "Plugin update failed");
          return false;
        }
      }
      options = { ...options, pluginManifests: pluginPaths };
      const recovering = previous?.status === "failed" || previous?.status === "applying";
      const applicationRecovery = recovering && !["plugin-update", "plugin-update-failed"].includes(previous.reason);
      if (plan.packageAction === "keep" && !applicationRecovery) {
        if (!runtime.healthy(cfg, plan.currentVersion)) throw new Error("the package is current but its running version is not healthy; use the doctor plugin before retrying");
        record("succeeded", pluginsUpdated ? "plugins-updated" : "already-current");
        feedback.ok(`package ${plan.currentVersion} is current and healthy; participating plugins are up to date`);
        return true;
      }
      if (cfg.executionNode) {
        try {
          const result = await updateIndependentRelease(cfg, plan.targetVersion, options, record);
          keepRequestedUpdate = state.readUpdate(cfg.dataDir)?.reason === "routine-scripts-active";
          return result;
        }
        catch (error) {
          record("failed", "candidate-preparation-failed");
          feedback.err(error instanceof Error ? error.message : "Candidate preparation failed");
          return false;
        }
      }
      // Do not accidentally install to another npm prefix and only discover that
      // mismatch after replacing an unrelated global package.
      const prefix = releases.globalPrefix(cfg);
      if ((options.automatic || options.request) && !runtime.canManageServices()) {
        throw new Error("automatic updates require non-interactive service-management access");
      }
      // Every package replacement holds admission closed and verifies both the DB
      // and runner. Manual invocation and --force never authorize interrupting a turn.
      endMaintenance = state.beginMaintenance(cfg);
      let idle: boolean;
      try { idle = await runtime.legacyIdle(cfg); }
      catch {
        keepRequestedUpdate = true;
        if (!recovering) record("deferred", "idle-state-unverified");
        feedback.warn("could not verify an idle maintenance window; update deferred without changing the package");
        return options.automatic || options.request ? true : false;
      }
      if (!idle) {
        keepRequestedUpdate = true;
        if (!recovering) record("deferred", "tasks-active");
        feedback.info("tasks are running, waiting, or queued; update deferred without interrupting sessions");
        return options.automatic || options.request ? true : false;
      }
      if (options.automatic || options.request) {
        const latestSettings = configuration.preferences(cfg.dataDir);
        if ((options.automatic && !latestSettings.autoUpdate) || latestSettings.channel !== plan.channel) {
          record("deferred", "settings-changed");
          return true;
        }
      }
      // Preserve a legacy preference while its package metadata is still intact.
      configuration.initializePreferences(cfg.dataDir);
      record("applying", "package-install");
      try {
        feedback.info(`updating the package to ${plan.targetVersion}; participating plugins are prepared`);
        if (!releases.installGlobal(plan.targetVersion, prefix)) throw new Error("package installation failed");
        releases.verifyCli(cfg, plan.targetVersion, false);
        const identity = releases.identity(cfg.pkgDir!);
        releases.activateInstalled(cfg, options, plan.targetVersion);
        if (!runtime.healthy(cfg, plan.targetVersion)) throw new Error("the running service does not match the healthy target version");
        await releases.verifyApplication(identity, cfg);
        const finalPlugins = releases.readPlugins(pluginPaths);
        if (finalPlugins.some((plugin) => !compatiblePlugin(plan.targetVersion, plugin.version))) throw new Error("a plugin changed during the update and is no longer compatible");
        record("succeeded", "runtime-and-compatibility-verified");
        feedback.ok(`package ${plan.targetVersion} is healthy; ${plugins.length ? "participating plugin compatibility is verified" : "the plugin compatibility line is unchanged"}`);
        return true;
      } catch (error) {
        record("failed", "manual-recovery-required");
        feedback.err(`${error instanceof Error ? error.message : "update failed"}; automatic retries are paused. Use the doctor/update plugin to recover; the previous package and database were not restored.`);
        return false;
      }
    } catch (error) {
      if (!options.request || !canRecordRequestError) throw error;
      state.writeUpdate(cfg.dataDir, { status: "deferred", previousVersion: options.request.currentVersion,
        targetVersion: options.request.targetVersion, reason: "request-failed" });
      feedback.err("the requested update could not start; check availability or use the update plugin");
      return false;
    } finally {
      try {
        endMaintenance?.();
        if (options.request && !keepRequestedUpdate) state.clearRequest(cfg, options.request.id);
      } finally { unlock(); }
    }
  }

  async function updateIndependentRelease(cfg: InstallConfig, version: string, options: InstallationOptions,
    record: (status: "applying" | "succeeded" | "failed" | "deferred", reason: string) => void): Promise<boolean> {
    if (!cfg.supervisor && !runtime.canManageServices()) throw new Error("Updates require non-interactive service-management access");
    record("applying", "candidate-preparation");
    const candidate = releases.stage(cfg, version);
    const identity = releases.identity(candidate.pkgDir!);
    releases.verifyCli(candidate, version, true);
    const endMaintenance = state.beginMaintenance(cfg);
    let changed = false;
    try {
      if (!await verifyIndependentActivation(runtime, cfg)) {
        record("deferred", "routine-scripts-active");
        return true;
      }
      const settings = configuration.preferences(cfg.dataDir);
      if ((options.automatic && !settings.autoUpdate) || ((options.automatic || options.request) && settings.channel !== candidate.releaseChannel)) {
        record("deferred", "settings-changed"); return true;
      }
      runtime.verifyCompatibility(candidate);
      record("applying", "application-activation");
      // The previous immutable release remains available for recovery. Execution
      // hosts retain their own references and are never restarted here.
      state.writeActivation(cfg, { previous: cfg, target: candidate, status: "applying" });
      changed = true;
      provisionIndependentRuntime(candidate, options);
      configuration.save(candidate);
      await runtime.restartWeb(candidate);
      if (!await runtime.waitHealthy(candidate, version)) throw new Error("Candidate application health check failed");
      await releases.verifyApplication(identity, candidate);
      if (settings.autoUpdate) await runtime.configureAutoUpdate(candidate);
      const pluginPaths = options.pluginManifests;
      if (releases.readPlugins(pluginPaths).some((plugin) => !compatiblePlugin(version, plugin.version))) throw new Error("An operator plugin changed during activation");
      configuration.persistChannel(candidate, options.channel !== undefined);
      record("succeeded", "application-and-executions-verified");
      state.writeActivation(cfg, { previous: cfg, target: candidate, status: "succeeded", verification: identity });
      return true;
    } catch (error) {
      if (changed) {
        let restored = false;
        try {
          provisionIndependentRuntime(cfg, options); configuration.save(cfg); await runtime.restartWeb(cfg);
          restored = await runtime.waitHealthy(cfg, releases.installedVersion(cfg.pkgDir));
          if (restored && configuration.preferences(cfg.dataDir).autoUpdate) await runtime.configureAutoUpdate(cfg);
        } catch { /* Retain both releases for explicit recovery. */ }
        state.writeActivation(cfg, { previous: cfg, target: candidate, status: restored ? "restored" : "recovery-required" });
      }
      record("failed", "application-activation-failed");
      feedback.err(error instanceof Error ? error.message : "Application activation failed");
      return false;
    } finally { endMaintenance(); }
  }

  return update;
}
