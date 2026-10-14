import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import type { InstallConfig } from "../../domain/installation.js";
import type { InstallationRuntime, RetainedReleaseOperations } from "../../application/ports/outbound/installation.js";
import { installedHostArtifactPaths } from "../../../../platform/process/host-artifacts.js";
import { activateDaemon, configureDaemon, daemonConfiguration, writeDaemonConfiguration } from "./daemon-runtime.js";
import { assertDaemonBootstrapSupported, installDaemonBootstrap, removeDaemonBootstrap, removeDaemonRegistration, restoreDaemonBootstrap, startDaemonBootstrap, stopDaemonBootstrap } from "./daemon-bootstrap.js";
import { assertInstallationOwner, daemonServiceName, prepareUserService, verifyUserIsolation } from "./user-service.js";
import { installTerminalUnits } from "./terminal-units.js";
import { releaseContract, retainInstalledRelease } from "./execution-release.js";
import { installExecutionUnits } from "./execution-units.js";
import { assertSafeInstallerIdentity } from "./config.js";
import { configureAutoUpdate, retireAutoUpdateTimer, removeAutoUpdateTimer } from "./auto-update.js";
import { verifyUpdateIdle } from "./update-idle.js";
import { preflight } from "./checks.js";
import { connectionInfo } from "./connection.js";
import { recordRunnerArtifact, runnerArtifactChanged } from "./runner-state.js";
import { renderUnits, runnerUnitName, webUnitName } from "./units.js";
import { canSudoNonInteractive, log, run, sudo, sudoWriteFile } from "./sh.js";

const SYSTEMD_DIR = "/etc/systemd/system";
function applyUnits(
  cfg: InstallConfig,
  dryRun: boolean,
): { runnerChanged: boolean } {
  if (cfg.supervisor === "palmagentd") {
    if (dryRun) log.info("[dry-run] would write the private daemon runtime configuration");
    else configureDaemon(cfg);
    return { runnerChanged: false };
  }
  const units = renderUnits(cfg);
  if (cfg.executionNode) {
    if (dryRun) { log.plain(units.web.text); return { runnerChanged: false }; }
    installExecutionUnits(cfg);
    // Rollback may reactivate an older retained package without terminal support.
    if (releaseContract(cfg.pkgDir!).terminalProtocol === 1) installTerminalUnits(cfg);
    if (!sudoWriteFile(join(SYSTEMD_DIR, units.web.name), units.web.text)) throw new Error("Could not install application service");
    if (!sudo(["systemctl", "daemon-reload"]).ok || !sudo(["systemctl", "enable", units.web.name]).ok) throw new Error("Could not activate independent application units");
    return { runnerChanged: false };
  }
  const webPath = join(SYSTEMD_DIR, units.web.name);
  const runnerPath = join(SYSTEMD_DIR, units.runner.name);

  // Restart only when the runner unit or executable artifact changed (or it is
  // not installed), so in-flight turns survive a web-only update.
  let installedRunner: string | undefined;
  try {
    installedRunner = readFileSync(runnerPath, "utf8");
  } catch {
    // Missing or unreadable means the unit must be installed.
  }
  const runnerChanged = installedRunner !== units.runner.text;

  if (dryRun) {
    log.info(`[dry-run] would write ${webPath} and ${runnerPath}`);
    log.info(
      `[dry-run] runner ${runnerChanged ? "CHANGED → would restart" : "unchanged → would leave running"}`,
    );
    log.plain(`\n# ${runnerPath}\n${units.runner.text}`);
    log.plain(`\n# ${webPath}\n${units.web.text}`);
    return { runnerChanged };
  }

  if (!sudoWriteFile(runnerPath, units.runner.text))
    throw new Error(`failed to write ${runnerPath}`);
  if (!sudoWriteFile(webPath, units.web.text))
    throw new Error(`failed to write ${webPath}`);
  const reloaded = sudo(["systemctl", "daemon-reload"]);
  if (!reloaded.ok) throw new Error(`systemd daemon-reload failed:\n${reloaded.stderr}`);
  const enabled = sudo(["systemctl", "enable", units.runner.name, units.web.name]);
  if (!enabled.ok) throw new Error(`failed to enable Palmagent units:\n${enabled.stderr}`);
  return { runnerChanged };
}


function waitForRunner(cfg: InstallConfig): void {
  for (let i = 0; i < 15; i++) {
    const active = run("systemctl", [
      "is-active",
      "--quiet",
      runnerUnitName(),
    ]).ok;
    if (active && existsSync(cfg.runnerSocket)) return;
    run("sleep", ["1"]);
  }
  throw new Error(
    `runner did not become active at ${cfg.runnerSocket}; see journalctl -u ${runnerUnitName()} -n 50`,
  );
}


function restartRunner(cfg: InstallConfig): void {
  const restarted = sudo(["systemctl", "restart", runnerUnitName()]);
  if (!restarted.ok)
    throw new Error(`failed to restart ${runnerUnitName()}:\n${restarted.stderr}`);
  waitForRunner(cfg);
  recordRunnerArtifact(cfg);
}


async function restartWeb(cfg: InstallConfig): Promise<void> {
  if (cfg.supervisor === "palmagentd") { await activateDaemon(cfg); return; }
  const restarted = sudo(["systemctl", "restart", webUnitName()]);
  if (!restarted.ok)
    throw new Error(`failed to restart ${webUnitName()}:\n${restarted.stderr}`);
}


async function startServices(cfg: InstallConfig): Promise<void> {
  if (cfg.supervisor === "palmagentd") { startDaemonBootstrap(cfg); return; }
  const units = renderUnits(cfg);
  if (units.runner.name !== runnerUnitName() || units.web.name !== webUnitName()) {
    throw new Error("rendered unit names do not match the installed Palmagent units");
  }
  if (!cfg.executionNode) restartRunner(cfg);
  await restartWeb(cfg);
}


function runtimeIsHealthy(cfg: InstallConfig, expectedVersion?: string): boolean {
  const r = run("curl", ["--max-time", "5", "-fsS", `${connectionInfo(cfg).upstream}/api/health`]);
  if (!r.ok) return false;
  try {
    const health = JSON.parse(r.stdout);
    return health.ok === true && (!expectedVersion || health.build?.version === expectedVersion);
  } catch { return false; }
}


async function healthcheck(cfg: InstallConfig, expectedVersion?: string): Promise<boolean> {
  // Host-local transport stays on loopback. Browser-facing HTTPS is owned
  // by the operator plugin or external host ingress.
  for (let i = 0; i < 30; i++) {
    if (runtimeIsHealthy(cfg, expectedVersion)) return true;
    run("sleep", ["1"]);
  }
  return false;
}


function finishMigrationCleanup(previous: InstallConfig): void {
  if (previous.supervisor === "palmagentd") removeDaemonRegistration(previous);
  else {
    removeAutoUpdateTimer();
    for (const unit of [webUnitName(), runnerUnitName()]) {
      if (!sudo(["rm", "-f", join(SYSTEMD_DIR, unit)]).ok) throw new Error("Could not remove an idle legacy service");
    }
    for (const path of installedHostArtifactPaths()) {
      if (!sudo(["rm", "-f", path]).ok) throw new Error("Could not remove an idle legacy service artifact");
    }
    if (!sudo(["systemctl", "daemon-reload"]).ok) throw new Error("Could not reload bootstrap configuration");
  }
}


function provisionIndependentRuntime(cfg: InstallConfig, dryRun: boolean): void {
  if (!dryRun && releaseContract(cfg.pkgDir!).hostSetup === 1 && releaseContract(cfg.pkgDir!).ingressOwner === "plugin") {
    const result = run(cfg.executionNode!, [join(cfg.pkgDir!, "cli.js"), "runtime-setup", "--data-dir", cfg.dataDir, "--non-interactive"], {
      env: { ...process.env, PALMAGENT_CLI_FORWARDED: "1" }, timeout: 60_000,
    });
    if (!result.ok) throw new Error("Candidate runtime provisioning failed");
  } else {
    // Legacy candidate setup can mutate shared ingress. Restore only application
    // units through this CLI; never execute its old proxy provisioning path.
    applyUnits(cfg, dryRun);
  }
}

export function createInstallationRuntime(releases: RetainedReleaseOperations): InstallationRuntime {
  return {
    assertIdentity: assertSafeInstallerIdentity, assertOwner: assertInstallationOwner,
    assertBootstrapSupported: assertDaemonBootstrapSupported, canManageServices: canSudoNonInteractive,
    preflight, prepareUserService, verifyUserIsolation, retainRelease: retainInstalledRelease,
    configure: applyUnits, artifactChanged: runnerArtifactChanged, installBootstrap: installDaemonBootstrap,
    start: startServices, restartRunner, restartWeb, healthy: runtimeIsHealthy, waitHealthy: healthcheck,
    async activity(config) {
      const response = await fetch(`${connectionInfo(config).upstream}/api/health`, { signal: AbortSignal.timeout(5000) });
      const health = await response.json() as { ok?: boolean; updateMaintenance?: boolean; executionProtocol?: number; activeRoutineScripts?: number; updateBlockingRoutineScripts?: number };
      return { verified: response.ok, healthy: health.ok, maintenance: health.updateMaintenance,
        executionProtocol: health.executionProtocol, activeRoutineScripts: health.activeRoutineScripts,
        updateBlockingRoutineScripts: health.updateBlockingRoutineScripts };
    },
    legacyIdle: verifyUpdateIdle, verifyCompatibility: releases.verifyActiveExecutionCompatibility,
    assertExecutionsFinished: releases.assertExecutionsFinished,
    configureAutoUpdate: async config => { await configureAutoUpdate(config, true); }, retireAutoUpdateTimer,
    serviceDescription: config => config.supervisor ? daemonServiceName(config) : `${webUnitName()} and ${runnerUnitName()}`,
    healthFailureHint: config => `service did not become healthy — see: journalctl ${config.daemonScope === "user" ? "--user " : ""}-u ${config.supervisor ? daemonServiceName(config) : webUnitName()} -n 50`,
    validateCandidate: config => { daemonConfiguration(config); },
    snapshotDaemonConfig: config => config.supervisor === "palmagentd" ? readFileSync(join(config.dataDir, "daemon/config.json"), "utf8") : undefined,
    configureDaemon: config => { configureDaemon(config); },
    async stopPrevious(config) {
      if (config.supervisor === "palmagentd") await stopDaemonBootstrap(config);
      else for (const unit of [webUnitName(), ...(!config.executionNode ? [runnerUnitName()] : [])]) {
        if (!sudo(["systemctl", "disable", "--now", unit]).ok) throw new Error("Could not stop a legacy service");
      }
    },
    restoreBootstrap: restoreDaemonBootstrap,
    async removeCandidate(config, started) { if (started) await removeDaemonBootstrap(config); else removeDaemonRegistration(config); },
    async restorePrevious(config, daemonConfig, cause) {
      if (daemonConfig !== undefined) {
        writeDaemonConfiguration(config.dataDir, JSON.parse(daemonConfig));
        restoreDaemonBootstrap(config);
      } else {
        const units = [webUnitName(), ...(!config.executionNode ? [runnerUnitName()] : [])];
        if (!sudo(["systemctl", "enable", ...units]).ok) throw new Error("Could not restore legacy startup", { cause });
        await startServices(config);
      }
    },
    finishMigration: finishMigrationCleanup,
    async removeServices(config) {
      if (config.supervisor === "palmagentd") await removeDaemonBootstrap(config);
      else removeAutoUpdateTimer();
      if (!config.supervisor) {
        const units = renderUnits(config);
        for (const name of [units.web.name, units.runner.name]) {
          sudo(["systemctl", "disable", "--now", name]);
          sudo(["rm", "-f", join(SYSTEMD_DIR, name)]);
        }
        if (config.executionNode) for (const path of installedHostArtifactPaths()) sudo(["rm", "-f", path]);
        sudo(["systemctl", "daemon-reload"]);
      }
    },
    purge(config) {
      if (config.daemonScope === "user") rmSync(config.dataDir, { recursive: true });
      else {
        const result = sudo(["rm", "-rf", config.dataDir]);
        if (!result.ok) throw new Error(`failed to purge ${config.dataDir}:\n${result.stderr}`);
      }
    },
    retainedCandidate(config, packageDirectory, node) {
      const release = realpathSync(packageDirectory), runtime = realpathSync(node);
      if (!release.startsWith(realpathSync(join(config.dataDir, "releases")) + sep) ||
          !runtime.startsWith(realpathSync(join(config.dataDir, "runtimes")) + sep)) throw new Error("Runtime setup requires retained package and Node artifacts");
      return { ...config, pkgDir: release, workingDir: release, executionNode: runtime };
    },
    provisionCandidate: provisionIndependentRuntime,
    isPostUpgrade: () => process.env.PALMAGENT_UPDATE_POST_UPGRADE === "1",
  };
}
