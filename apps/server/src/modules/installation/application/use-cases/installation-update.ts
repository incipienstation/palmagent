import type { ActivationReceipt } from "../../domain/installation-observations.js";
import { BRANDING } from "@palmagent/shared";
import type { InstallConfig } from "../../domain/installation.js";
import { channelTag, compatiblePlugin, releaseChannel, validateUpdateTarget } from "../../domain/release-policy.js";
import type { InstallationOptions, InstallationUseCases } from "../ports/inbound/installation-use-cases.js";
import type { InstallationDependencies } from "../ports/outbound/installation.js";
import { releaseActivation } from "./release-activation.js";
import type { StandaloneUpdate } from "../ports/outbound/standalone-update.js";
import type { UpdatePlan } from "../../domain/update-plan.js";
import type { StandaloneSelection } from "@palmagent/shared/standalone";

export function createInstallationUpdate(dependencies: InstallationDependencies,
  lifecycle: Pick<InstallationUseCases, "provisionRuntime"> & { applyInstalledUpdate(config: InstallConfig, options: InstallationOptions): Promise<boolean> }) {
  const { configuration, state, runtime, releases, feedback } = dependencies;
  const { applyInstalledUpdate, provisionRuntime: provisionIndependentRuntime } = lifecycle;
  async function update(options: InstallationOptions): Promise<boolean> {
    const cfg = configuration.load(options.dataDir);
    if (cfg.daemonScope === "user") runtime.assertOwner(cfg);
    const selectedChannel = options.channel !== undefined
      ? releaseChannel(options.channel!)
      : configuration.preferences(cfg.dataDir).channel;
    cfg.releaseChannel = selectedChannel;
    const currentVersion = cfg.mode === "package" && !options.dryRun ? releases.installedVersion(cfg.pkgDir) : "";
    const resumedPlan = options.plannedTarget && options.plannedTarget.currentVersion !== currentVersion &&
      options.plannedTarget.targetVersion === currentVersion && state.readUpdate(cfg.dataDir)?.reason === "handoff-activation";
    if (options.plannedTarget && ((!resumedPlan && options.plannedTarget.currentVersion !== currentVersion) || options.plannedTarget.channel !== cfg.releaseChannel ||
        options.plannedTarget.targetVersion !== options.plannedTarget.selection.version ||
        (options.targetVersion && options.targetVersion !== options.plannedTarget.targetVersion) || options.distribution === "npm" || !options.pull))
      throw new Error("Update plan no longer matches this installation or request; plan again");
    const explicitVersion = options.targetVersion ?? options.plannedTarget?.targetVersion;
    const resolution = { installation: cfg, distribution: options.distribution,
      selection: options.request?.selection ?? options.plannedTarget?.selection };
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
      feedback.plan(releases.resolvePlan(currentVersion, cfg.releaseChannel, releases.participatingPlugins(releases.discoverPlugins(cfg), pluginPaths), requestedVersion, resolution));
      return true;
    }
    if (options.automatic && (!options.pull || explicitVersion || options.channel)) throw new Error("--automatic requires --pull and follows only the saved channel");
    feedback.step(`${BRANDING.productName} update`);
    feedback.info(`Update channel: ${cfg.releaseChannel === "stable" ? "Stable" : "Preview"}`);
    if (!options.pull) return applyInstalledUpdate(cfg, options);
    if (options.automatic && !configuration.preferences(cfg.dataDir).autoUpdate) {
      feedback.info("automatic updates are off; nothing changed");
      return true;
    }
    if (options.dryRun) {
      const standalone = options.distribution === "standalone" || cfg.distribution === "standalone" || cfg.releaseChannel === "preview";
      const target = standalone ? `${BRANDING.packageName} standalone ${requestedVersion ?? cfg.releaseChannel}`
        : `${BRANDING.packageName}@${requestedVersion ?? channelTag(cfg.releaseChannel)}`;
      feedback.info(`[dry-run] would resolve ${target}, verify plugin compatibility, install the exact target, and verify runtime health`);
      return true;
    }

    const unlock = state.lock();
    let endMaintenance: (() => void) | undefined;
    let keepRequestedUpdate = false;
    let canRecordRequestError = false;
    let nativeInFlight = false;
    const executor = () => (resolution.distribution !== "npm" && (resolution.distribution === "standalone" ||
      cfg.distribution === "standalone" || cfg.releaseChannel === "preview" || resolution.selection))
      ? releases.standaloneExecutor?.(cfg.pkgDir) : undefined;
    try {
      if (options.request && !state.validRequest(cfg, options.request)) return true;
      const previous = state.readUpdate(cfg.dataDir);
      if (previous?.status === "applying" && previous.reason === "handoff-activation") {
        keepRequestedUpdate = true;
        const saved = state.readActivation(cfg);
        const handoff = saved?.handoff;
        if (!saved || !["applying", "succeeded"].includes(saved.status) || !handoff || !saved.verification || handoff.targetVersion !== previous.targetVersion ||
            handoff.previousVersion !== previous.previousVersion || saved.verification.version !== handoff.targetVersion ||
            ![saved.previous.pkgDir, saved.target.pkgDir].includes(cfg.pkgDir) ||
            [saved.previous, saved.target].some(side => side.dataDir !== cfg.dataDir || side.dbPath !== cfg.dbPath || side.user !== cfg.user) ||
            (options.channel && saved.target.releaseChannel !== options.channel) ||
            (options.plannedTarget && (handoff.previousVersion !== options.plannedTarget.currentVersion || handoff.manifestSha256 !== options.plannedTarget.selection.manifestSha256)) ||
            (requestedVersion && requestedVersion !== handoff.targetVersion) ||
            (options.request && options.request.id !== handoff.requestId)) {
          throw new Error("Interrupted activation does not match this installation and request");
        }
        const restoreConfig = (side: InstallConfig): InstallConfig => {
          if (!side.pkgDir || !side.executionNode) throw new Error("Retained activation artifact is missing");
          return { ...runtime.retainedCandidate(cfg, side.pkgDir, side.executionNode),
            distribution: side.distribution, artifactId: side.artifactId, releaseChannel: side.releaseChannel };
        };
        const old = restoreConfig(saved.previous), target = restoreConfig(saved.target);
        const native = releases.discoverPlugins(cfg);
        const manifests = [...new Set([...(handoff.pluginManifests ?? []), ...pluginPaths])];
        options = { ...options, pluginManifests: releases.participatingPlugins(native, manifests).map(plugin => plugin.manifest) };
        const resumedRecord: RecordUpdate = (status, reason) => {
          if (status === "deferred") return; // Keep the pinned activation available on the next wake.
          state.writeUpdate(cfg.dataDir, { previousVersion: previous.previousVersion, targetVersion: previous.targetVersion,
            pluginsUpdated: previous.pluginsUpdated, pluginActivationPending: previous.pluginActivationPending, status, reason });
          if (status === "succeeded") state.clearDiscovery(cfg.dataDir);
        };
        const retained = { ...saved, previous: old, target };
        const owner = executor();
        nativeInFlight = Boolean(owner);
        const resumed = owner ? await nativeUpdate(owner, options, true, true, resumedRecord,
          () => releaseActivation(dependencies, provisionIndependentRuntime, old, handoff.targetVersion, options, undefined, retained))
          : await updateIndependentRelease(old, handoff.targetVersion, options, resumedRecord, undefined, retained);
        nativeInFlight = false;
        keepRequestedUpdate = state.readUpdate(cfg.dataDir)?.status === "applying";
        return resumed;
      }
      if (resumedPlan) throw new Error("The pinned activation is no longer pending; plan again");
      if ((options.automatic || options.request) && (previous?.status === "failed" || previous?.status === "applying")) {
        feedback.warn("automatic updates are paused after an unsuccessful attempt; use the update plugin to inspect and recover");
        return true;
      }
      canRecordRequestError = true;
      let native: ReturnType<typeof releases.discoverPlugins>;
      let plan!: UpdatePlan;
      const resolve = () => {
        native = releases.discoverPlugins(cfg);
        plugins = releases.participatingPlugins(native, pluginPaths);
        pluginPaths = plugins.map(p => p.manifest);
        plan = releases.resolvePlan(currentVersion, selectedChannel, plugins, requestedVersion, resolution);
        return { eligible: plan.automaticEligible, hasPlugins: Boolean(plugins.length),
          refresh: plan.plugins.some(p => p.action === "update"), keep: plan.packageAction === "keep" };
      };
      let pluginsUpdated = 0;
      const record = (status: "applying" | "succeeded" | "failed" | "deferred", reason: string) => {
        state.writeUpdate(cfg.dataDir, {
          status, previousVersion: plan.currentVersion, targetVersion: plan.targetVersion, reason,
          ...(pluginsUpdated ? { pluginsUpdated, pluginActivationPending: true } : {}),
        });
        if (status === "succeeded") state.clearDiscovery(cfg.dataDir);
      };
      function ensureManagedPlugins() {
        if (plan.plugins.some(p => p.action === "update" && !native.some(n => n.manifest === p.manifest)))
          throw new Error("the target needs a matching plugin; refresh it through its native manager and retry");
      }
      function refresh() {
        const refreshed = releases.refreshPlugins(cfg, plan, native);
        pluginsUpdated = plan.plugins.filter(p => p.action === "update").length;
        pluginPaths = releases.participatingPlugins(refreshed, pluginPaths.filter(path => !native.some(p => p.manifest === releases.canonicalPluginPath(path)))).map(p => p.manifest);
        feedback.ok(`updated ${pluginsUpdated} operator plugin(s); start a new agent session to load their skills`);
      }
      const recovering = previous?.status === "failed" || previous?.status === "applying";
      const applicationRecovery = recovering && !["plugin-update", "plugin-update-failed"].includes(previous.reason);
      const owner = executor();
      if (owner) {
        nativeInFlight = true;
        const result = await nativeUpdate(owner, options, false, applicationRecovery, record,
          () => releaseActivation(dependencies, provisionIndependentRuntime, cfg, plan.targetVersion,
            { ...options, pluginManifests: pluginPaths }, plan.selection), {
            resolve, refresh: () => { ensureManagedPlugins(); refresh(); },
            verifyCurrent: () => {
              if (!runtime.healthy(cfg, plan.currentVersion)) throw new Error("The installed release is not healthy");
            },
          });
        nativeInFlight = false;
        keepRequestedUpdate = ["routine-scripts-active", "tasks-active", "admissions-pending"].includes(state.readUpdate(cfg.dataDir)?.reason ?? "");
        return result;
      }
      resolve();
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
        ensureManagedPlugins();
        record("applying", "plugin-update");
        try { refresh(); }
        catch (error) {
          record("failed", "plugin-update-failed");
          feedback.err(error instanceof Error ? error.message : "Plugin update failed");
          return false;
        }
      }
      options = { ...options, pluginManifests: pluginPaths };
      if (plan.packageAction === "keep" && !applicationRecovery) {
        if (!runtime.healthy(cfg, plan.currentVersion)) throw new Error("the package is current but its running version is not healthy; use the doctor plugin before retrying");
        record("succeeded", pluginsUpdated ? "plugins-updated" : "already-current");
        feedback.ok(`package ${plan.currentVersion} is current and healthy; participating plugins are up to date`);
        return true;
      }
      if (cfg.executionNode || plan.targetDistribution === "standalone") {
        try {
          const result = await updateIndependentRelease(cfg, plan.targetVersion, options, record, plan.selection);
          keepRequestedUpdate = ["routine-scripts-active", "tasks-active", "admissions-pending"].includes(state.readUpdate(cfg.dataDir)?.reason ?? "");
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
      if (nativeInFlight && state.readUpdate(cfg.dataDir)?.status === "applying") {
        keepRequestedUpdate = true;
        throw error;
      }
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
    record: (status: "applying" | "succeeded" | "failed" | "deferred", reason: string) => void,
    selection?: StandaloneSelection, resume?: ActivationReceipt): Promise<boolean> {
    if (!resume) record("applying", "candidate-preparation");
    const effects = releaseActivation(dependencies, provisionIndependentRuntime, cfg, version, options, selection, resume);
    const compatibility = effects.stage();
    if (resume && !compatibility.live) throw new Error("Interrupted release pair no longer supports handoff");
    if (compatibility.live) await effects.openGateway();
    let changed = false;
    try {
      const block = await effects.admission();
      if (block) { record("deferred", block); return true; }
      if (!effects.preferences()) { record("deferred", "settings-changed"); return true; }
      effects.prepareIntent();
      record("applying", compatibility.live ? "handoff-activation" : "application-activation");
      changed = true;
      if (!resume || effects.needsSwitch()) { effects.configure(); await effects.restart(); }
      await effects.verify();
      effects.commit();
      record("succeeded", "application-and-executions-verified");
      return true;
    } catch (error) {
      if (changed) {
        const restored = compatibility.rollback && await effects.restore().catch(() => false);
        effects.recoveryReceipt(restored);
        if (!compatibility.rollback) feedback.err("Candidate storage may have changed. The previous release cannot safely reopen it.");
      }
      record("failed", "application-activation-failed");
      feedback.err(error instanceof Error ? error.message : "Application activation failed");
      return false;
    } finally { await effects.close(); }
  }

  async function nativeUpdate(owner: StandaloneUpdate, options: InstallationOptions, resume: boolean,
    recoverApplication: boolean, record: RecordUpdate, prepare: () => ReturnType<typeof releaseActivation>,
    discovery?: { resolve(): unknown; refresh(): void; verifyCurrent(): void }) {
    let activation: ReturnType<typeof releaseActivation> | undefined;
    try {
      return await owner({ resume, automatic: Boolean(options.automatic), recoverApplication }, async command => {
        switch (command.op) {
          case "resolve": return discovery!.resolve();
          case "refreshPlugins": return discovery!.refresh();
          case "verifyCurrent": return discovery!.verifyCurrent();
          case "record": return record(command.status, command.reason);
          case "report": return feedback.err(command.message);
          case "stage": activation = prepare(); return activation.stage();
          case "recoveryReceipt": return activation!.recoveryReceipt(command.restored);
          default: return activation![command.op]();
        }
      });
    } finally { await activation?.close(); }
  }

  return update;
}

type RecordUpdate = (status: "applying" | "succeeded" | "failed" | "deferred", reason: string) => void;
