import { BRANDING } from "@palmagent/shared";
import type { InstallConfig } from "../../domain/installation.js";
import { channelTag } from "../../domain/release-policy.js";
import type { InstallationOptions } from "../ports/inbound/installation-use-cases.js";
import type { InstallationDependencies } from "../ports/outbound/installation.js";
import { verifyIndependentActivation } from "./installation-activation.js";

export function createInstallationLifecycle(dependencies: InstallationDependencies) {
  const { configuration, state, runtime, releases, feedback, diagnostics } = dependencies;
  async function install(options: InstallationOptions): Promise<boolean> {
    feedback.step(`${BRANDING.productName} install`);
    if (!options.dryRun) runtime.assertIdentity();
    if (configuration.exists(options.dataDir)) return setup(options);
    const pf = runtime.preflight();
    feedback.checks("Preflight", pf);
    const failed = pf.some(check => check.level === "fail");
    if (failed && !options.force) {
      feedback.err(
        "preflight failed — fix the above or re-run with --force. Aborting.",
      );
      return false;
    }
    const cfg = await configuration.resolve(options);
    if (cfg.supervisor) runtime.assertBootstrapSupported();
    if (cfg.daemonScope !== "user" && !options.dryRun && !runtime.canManageServices()) {
      feedback.warn("sudo will prompt for legacy system service registration.");
    }
    feedback.step("Configuration");
    feedback.info(
      `mode=${cfg.mode}  domain=${cfg.domain}  port=${cfg.port}  user=${cfg.user}  data=${cfg.dataDir}`,
    );
    if (
      !options.dryRun &&
      options.interactive &&
      !(await feedback.confirm("Proceed with this configuration?"))
    )
      return false;

    if (!options.dryRun) {
      if (cfg.daemonScope === "user") runtime.prepareUserService(cfg);
      runtime.retainRelease(cfg);
      if (cfg.daemonScope === "user") runtime.verifyUserIsolation(cfg);
      configuration.persistChannel(cfg, options.channel !== undefined);
      const saved = configuration.save(cfg);
      feedback.ok(`wrote ${saved}`);
    } else {
      if (cfg.daemonScope === "user") {
        runtime.prepareUserService(cfg, true);
        feedback.info("[dry-run] would enable user lingering if needed, verify delegated isolation, and register a user service without sudo");
      }
      feedback.info("[dry-run] would write install.env");
    }

    feedback.step(cfg.supervisor ? "daemon runtime and bootstrap" : "systemd units");
    runtime.configure(cfg, options.dryRun);
    if (!options.dryRun && cfg.supervisor === "palmagentd") runtime.installBootstrap(cfg);

    if (!options.dryRun) {
      feedback.step("starting services");
      await runtime.start(cfg);
      const ok = await runtime.waitHealthy(cfg);
      if (!ok) {
        feedback.err(
          runtime.healthFailureHint(cfg),
        );
        return false;
      }
      feedback.ok(
        `host-local health check passed; public origin is https://${cfg.domain}`,
      );
      if (!cfg.supervisor) runtime.retireAutoUpdateTimer();
      if (configuration.preferences(cfg.dataDir).autoUpdate) await runtime.configureAutoUpdate(cfg);
      feedback.info(`After the operator plugin verifies public HTTPS, run ${BRANDING.cliName} passkey to enroll the first device.`);
    }

    feedback.step("done");
    feedback.ok(
      `${BRANDING.productName} runtime installed. Public HTTPS must be configured and verified by the operator plugin.`,
    );
    return true;
  }

  async function setup(options: InstallationOptions): Promise<boolean> {
    feedback.step(`${BRANDING.productName} setup (reconfigure)`);
    if (!options.dryRun) runtime.assertIdentity();
    const cfg = await configuration.resolve(options, true);
    // Check the current listener, even when reconfiguration selects a new port.
    const installed = configuration.load(options.dataDir);
    return withIdleActivation(installed, options, async () => {
      const receipt = !options.dryRun && installed.daemonScope === "user" ? state.readMigration(cfg) : undefined;
      if (receipt) {
        if (receipt.previous.dataDir !== installed.dataDir || receipt.previous.user !== installed.user ||
            receipt.previous.daemonScope === "user" || receipt.target.dataDir !== installed.dataDir || receipt.target.daemonScope !== "user") {
          throw new Error("Migration receipt does not match this installation; inspect it before continuing");
        }
        if (!await runtime.waitHealthy(installed)) throw new Error("Interrupted migration needs recovery: the user runtime is not healthy; previous services have been retained");
        runtime.finishMigration(receipt.previous);
        state.clearMigration(cfg);
      }
      const migration = cfg.supervisor === "palmagentd" && (installed.supervisor !== "palmagentd" || installed.daemonScope !== "user");
      if (migration && options.dryRun) {
        runtime.assertBootstrapSupported();
        runtime.prepareUserService(cfg, true);
        feedback.info("[dry-run] would verify an idle installation and user isolation, migrate to a user service, and remove the previous system services after health verification (one-time sudo)");
        return true;
      }
      if (migration && !options.dryRun) {
        runtime.assertBootstrapSupported();
        const health = await runtime.activity(installed);
        if (!health.verified || health.activeRoutineScripts !== 0) throw new Error("Migration requires verified idle routine scripts; update the existing runtime first if its health contract is older");
        runtime.assertExecutionsFinished(installed);
        runtime.prepareUserService(cfg);
        runtime.retainRelease(cfg);
        runtime.validateCandidate(cfg); // Validate all artifacts before stopping the previous web service.
        runtime.verifyUserIsolation(cfg);
        const previousDaemonConfig = runtime.snapshotDaemonConfig(installed);
        state.writeMigration(cfg, { previous: installed, previousDaemonConfig, target: cfg });
        // Existing hosts cannot be transferred with their cgroups. Migration requires an idle window.
        let candidateStarted = false;
        try {
          runtime.installBootstrap(cfg, false);
          await runtime.stopPrevious(installed);
          runtime.configureDaemon(cfg);
          configuration.save(cfg); candidateStarted = true; runtime.restoreBootstrap(cfg);
          if (!await runtime.waitHealthy(cfg)) throw new Error("Daemon migration health check failed");
        } catch (error) {
          // Stop the candidate web through its owner before restoring the old listener.
          try { await runtime.removeCandidate(cfg, candidateStarted); }
          catch {
            throw new Error("Migration failed and daemon shutdown could not be verified; retained both configurations for recovery", { cause: error });
          }
          configuration.save(installed);
          await runtime.restorePrevious(installed, previousDaemonConfig, error);
          if (!await runtime.waitHealthy(installed)) throw new Error("Legacy recovery health check failed", { cause: error });
          state.clearMigration(cfg);
          throw error;
        }
        configuration.persistChannel(cfg, options.channel !== undefined);
        runtime.finishMigration(installed);
        state.clearMigration(cfg);
        if (configuration.preferences(cfg.dataDir).autoUpdate) await runtime.configureAutoUpdate(cfg);
        feedback.ok("migrated to the user-owned daemon runtime during verified idle maintenance");
        return true;
      }
      return applySetup(cfg, options);
    });
  }

  async function applySetup(cfg: InstallConfig, options: InstallationOptions): Promise<boolean> {
    if (cfg.supervisor === "palmagentd" && cfg.daemonScope === "user") {
      runtime.prepareUserService(cfg, options.dryRun);
      if (!options.dryRun) runtime.retainRelease(cfg);
      const plan = runtime.prepareSetup(cfg);
      for (const line of plan.summary) feedback.info(`${options.dryRun ? "[dry-run] " : ""}${line}`);
      if (options.dryRun) return true;
      runtime.verifyUserIsolation(cfg);
      configuration.persistChannel(cfg, options.channel !== undefined);
      plan.apply();
      await runtime.restartWeb(cfg);
      const ok = await runtime.waitHealthy(cfg);
      feedback[ok ? "ok" : "err"](ok ? "healthy" : "not healthy after restart");
      if (ok && configuration.preferences(cfg.dataDir).autoUpdate) await runtime.configureAutoUpdate(cfg);
      return ok;
    }
    if (cfg.daemonScope === "user") {
      runtime.prepareUserService(cfg, options.dryRun);
      if (!options.dryRun) { runtime.retainRelease(cfg); runtime.verifyUserIsolation(cfg); runtime.installBootstrap(cfg); }
    }
    const artifactChanged = runtime.artifactChanged(cfg);
    if (!options.dryRun) {
      configuration.persistChannel(cfg, options.channel !== undefined);
      configuration.save(cfg);
      feedback.ok("updated install.env");
    }
    const { runnerChanged } = runtime.configure(cfg, options.dryRun);
    if (!options.dryRun) {
      if (!cfg.executionNode && (runnerChanged || artifactChanged)) {
        feedback.warn(
          `runner ${runnerChanged ? "unit" : "artifact"} changed — restarting the idle runner`,
        );
        runtime.restartRunner(cfg);
      } else {
        feedback.ok("runner unchanged — leaving it up so in-flight turns survive");
      }
      await runtime.restartWeb(cfg);
      const ok = await runtime.waitHealthy(cfg);
      feedback[ok ? "ok" : "err"](ok ? "healthy" : "not healthy after restart");
      if (ok && !cfg.supervisor) runtime.retireAutoUpdateTimer();
      if (ok && configuration.preferences(cfg.dataDir).autoUpdate) await runtime.configureAutoUpdate(cfg);
      return ok;
    }
    return true;
  }

  function prepareIndependentRuntime(options: InstallationOptions, pkgDir: string, node: string): boolean {
    runtime.assertIdentity();
    const installed = configuration.load(options.dataDir);
    if (!state.parentOwnsMaintenance(installed)) throw new Error("Runtime setup requires its live updater parent's maintenance window");
    const candidate = runtime.retainedCandidate(installed, pkgDir, node);
    runtime.verifyCompatibility(candidate);
    runtime.configure(candidate, options.dryRun);
    return true;
  }

  function provisionIndependentRuntime(cfg: InstallConfig, options: InstallationOptions): void {
    runtime.provisionCandidate(cfg, options.dryRun);
  }

  async function applyInstalledUpdate(cfg: InstallConfig, options: InstallationOptions): Promise<boolean> {
    const expectedVersion = options.expectedVersion;
    if (expectedVersion && (!runtime.isPostUpgrade() || releases.installedVersion(cfg.pkgDir) !== expectedVersion)) throw new Error("invalid update activation target");

    return withIdleActivation(cfg, options, () => activateInstalledUpdate(cfg, options, expectedVersion), expectedVersion);
  }

  async function withIdleActivation(cfg: InstallConfig, options: InstallationOptions, activate: () => Promise<boolean>, expectedVersion?: string): Promise<boolean> {
    if (options.dryRun) return activate();
    let unlock: (() => void) | undefined;
    let endMaintenance: (() => void) | undefined;
    try {
      if (expectedVersion) {
        // The package installer still owns the host lock and admission barrier.
        // An environment flag alone cannot bypass the direct activation guard.
        if (!state.parentOwnsMaintenance(cfg)) {
          throw new Error("update activation requires its live parent's maintenance window");
        }
      } else {
        unlock = state.lock();
        endMaintenance = state.beginMaintenance(cfg);
      }
      if (!(cfg.executionNode ? await verifyIndependentActivation(runtime, cfg) : await runtime.legacyIdle(cfg))) {
        feedback.warn("tasks are active; service activation deferred without interrupting sessions");
        return false;
      }
      return await activate();
    } finally {
      try { endMaintenance?.(); } finally { unlock?.(); }
    }
  }

  async function activateInstalledUpdate(cfg: InstallConfig, options: InstallationOptions, expectedVersion?: string): Promise<boolean> {
    // Re-render units; restart the runner only when its unit or artifact changed
    // after the guarded update has verified that no turns can be interrupted.
    if (!options.dryRun) runtime.retainRelease(cfg);
    const artifactChanged = runtime.artifactChanged(cfg);
    const { runnerChanged } = runtime.configure(cfg, options.dryRun);
    if (options.dryRun) return true;

    if (!cfg.executionNode && (runnerChanged || artifactChanged)) {
      feedback.warn(
        `runner ${runnerChanged ? "unit" : "artifact"} changed — restarting the idle runner`,
      );
      runtime.restartRunner(cfg);
    } else {
      feedback.ok("runner unchanged — leaving it up so in-flight turns survive");
    }
    await runtime.restartWeb(cfg);
    const ok = await runtime.waitHealthy(cfg, expectedVersion);
    if (ok) {
      if (!cfg.supervisor) runtime.retireAutoUpdateTimer();
      configuration.persistChannel(cfg, options.channel !== undefined);
      configuration.save(cfg);
      if (configuration.preferences(cfg.dataDir).autoUpdate) await runtime.configureAutoUpdate(cfg);
    }
    feedback[ok ? "ok" : "err"](ok ? `updated + healthy` : "not healthy after update");
    return ok;
  }

  async function uninstall(options: InstallationOptions): Promise<boolean> {
    feedback.step(`${BRANDING.productName} uninstall`);
    const cfg = configuration.load(options.dataDir);
    if (cfg.daemonScope === "user") runtime.assertOwner(cfg);
    if (options.purge) {
      configuration.assertPurgeTarget(cfg.dataDir);
    }
    if (options.dryRun) {
      feedback.info(
        `[dry-run] would stop+disable ${runtime.serviceDescription(cfg)} (${cfg.daemonScope ?? "system"} scope), remove its service files; preserve host proxy, TLS and user lingering`,
      );
      if (options.purge)
        feedback.info(`[dry-run] --purge would DELETE the data dir ${cfg.dataDir}`);
      return true;
    }
    if (
      options.interactive &&
      !(await feedback.confirm(
        `Remove ${BRANDING.productName} services on this host?`,
        false,
      ))
    )
      return false;

    const endExecutionMaintenance = cfg.executionNode ? state.beginMaintenance(cfg) : undefined;
    try {
      if (cfg.executionNode && !await verifyIndependentActivation(runtime, cfg)) throw new Error("Wait for routine scripts before removing the installation");
      runtime.assertExecutionsFinished(cfg);
      // Preserve a legacy channel before service data can be removed.
      configuration.initializePreferences(cfg.dataDir);
      await runtime.removeServices(cfg);
      feedback.ok("application services removed; host proxy and TLS resources preserved for operator cleanup");

      if (options.purge) {
        const approved =
          !options.interactive ||
          (await feedback.confirm(
            `DELETE all data at ${cfg.dataDir} (DB, push subscribers, VAPID keys — irreversible)?`,
            false,
          ));
        if (approved) {
          runtime.purge(cfg);
          feedback.ok(`purged ${cfg.dataDir}`);
        } else {
          feedback.info(`data preserved at ${cfg.dataDir}`);
        }
      } else {
        feedback.info(`data preserved at ${cfg.dataDir} (use --purge to delete)`);
      }
      return true;
    } finally { endExecutionMaintenance?.(); }
  }

  async function enrollPasskey(cfg: InstallConfig, options: Pick<InstallationOptions, "dryRun">, mint: (dbPath: string) => Promise<{ token: string; expiresAt: number }>): Promise<void> {
    if (options.dryRun) {
      feedback.info("[dry-run] would mint a first-passkey enroll link");
      return;
    }
    try {
      const { token, expiresAt } = await mint(cfg.dbPath);
      feedback.ok("First-passkey enroll link (single-use, 15 min):");
      feedback.plain(`\n    ${cfg.authOrigin}/#/enroll/${token}\n`);
      feedback.info(
        `expires ${new Date(expiresAt).toISOString()} — open it on the device you want to register`,
      );
    } catch (e) {
      feedback.warn(
        `could not mint enroll token: ${(e as Error).message}. Run \`${BRANDING.cliName} passkey\` later.`,
      );
    }
  }

  async function passkey(options: InstallationOptions, mint: (dbPath: string) => Promise<{ token: string; expiresAt: number }>): Promise<boolean> {
    const cfg = configuration.load(options.dataDir);
    await enrollPasskey(cfg, { dryRun: false }, mint);
    return true;
  }

  async function runDoctor(options: InstallationOptions): Promise<boolean> {
    const cfg = configuration.load(options.dataDir);
    let updateFailure = false;
    try {
      const receipt = state.readUpdate(cfg.dataDir);
      if (receipt) feedback.info(`Last update: ${receipt.status} (${receipt.previousVersion} → ${receipt.targetVersion}; ${receipt.reason})`);
      updateFailure = receipt?.status === "failed" || receipt?.status === "applying";
      if (updateFailure) feedback.warn("automatic retries are paused; inspect package/runtime identity and recover through the update plugin");
    } catch {
      updateFailure = true;
      feedback.warn("the last update result is unreadable; inspect it before retrying");
    }
    try {
      const channel = configuration.preferences(cfg.dataDir).channel;
      feedback.info(`Update channel: ${channel === "stable" ? "Stable" : "Preview"} (${channelTag(channel)})`);
    } catch {
      feedback.warn("Update channel is unknown: user or legacy settings could not be read");
    }
    const checks = [...await diagnostics.doctor(cfg), ...await diagnostics.application(cfg)];
    feedback.checks(`${BRANDING.productName} doctor — ${cfg.domain}`, checks);
    return !checks.some(check => check.level === "fail") && !updateFailure;
  }

  return { install, setup, uninstall, prepareRuntime: prepareIndependentRuntime, provisionRuntime: provisionIndependentRuntime,
    passkey, doctor: runDoctor, applyInstalledUpdate };
}
