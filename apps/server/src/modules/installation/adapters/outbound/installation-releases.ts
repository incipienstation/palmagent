import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { BRANDING } from "@palmagent/shared";
import type { InstallConfig } from "../../domain/installation.js";
import type { InstallationOptions } from "../../application/ports/inbound/installation-use-cases.js";
import type { InstallationReleases, RetainedReleaseOperations } from "../../application/ports/outbound/installation.js";
import { productVersion } from "../../domain/release-policy.js";
import { applicationIdentity, verifyApplication } from "./application-verification.js";
import { discoverPlugins, participatingPlugins, refreshPlugins } from "./plugin-update.js";
import { readPluginVersions, resolveUpdatePlan } from "./update-plan.js";
import { connectionInfo } from "./connection.js";
import { canSudoNonInteractive, log, run, sudo } from "./sh.js";

export function installedVersion(pkgDir?: string): string {
  if (!pkgDir) throw new Error("installed package directory is missing");
  const version = String(JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version);
  productVersion(version);
  return version;
}

function npmGlobalInstall(pkg: string, version: string, globalRoot: string): boolean {
  const spec = `${pkg}@${version}`;
  const first = run("npm", ["install", "-g", spec], { timeout: 600_000 });
  if (first.ok) return true;
  if (
    /EACCES|permission denied|EROFS/i.test(first.stderr) &&
    canSudoNonInteractive()
  ) {
    if (basename(globalRoot) !== "node_modules" || basename(dirname(globalRoot)) !== "lib") {
      throw new Error("cannot safely identify the existing npm prefix for a privileged retry");
    }
    log.info("retrying the global install with sudo …");
    return sudo(["npm", "install", "-g", "--prefix", dirname(dirname(globalRoot)), spec]).ok;
  }
  if (first.stderr.trim()) log.err(first.stderr.trim());
  return false;
}

export function postUpgradeArgs(
  cfg: InstallConfig,
  options: InstallationOptions,
): string[] {
  return [
    "update",
    "--data-dir",
    cfg.dataDir,
    ...(options.channel ? ["--channel", cfg.releaseChannel!] : []),
    ...(!options.interactive ? ["-y"] : []),
  ];
}

export function createInstallationReleases(retained: RetainedReleaseOperations): InstallationReleases {
  return {
    installedVersion, stage: retained.stageRelease, identity: applicationIdentity,
    verifyCli(config, version, retained) {
      const result = run(retained ? config.executionNode! : process.execPath, [join(config.pkgDir!, "cli.js"), "--version"],
        retained ? { env: { ...process.env, PALMAGENT_CLI_FORWARDED: "1" }, timeout: 10_000 } : {});
      if (!result.ok || result.stdout.trim() !== version || (!retained && installedVersion(config.pkgDir) !== version))
        throw new Error(retained ? "Candidate CLI identity check failed" : "installed package identity does not match the planned target");
    },
    verifyApplication: (identity, config) => verifyApplication(identity, connectionInfo(config).upstream),
    globalPrefix(config) {
      const root = run("npm", ["root", "-g"], { timeout: 10_000 });
      if (!root.ok || resolve(root.stdout.trim(), BRANDING.packageName) !== resolve(config.pkgDir!)) throw new Error("the active npm prefix does not own this installation; package files were not changed");
      return root.stdout.trim();
    },
    installGlobal: (version, prefix) => npmGlobalInstall(BRANDING.packageName, version, prefix),
    activateInstalled(config, options, version) {
      const child = spawnSync(process.execPath, [join(config.pkgDir!, "cli.js"), ...postUpgradeArgs(config, options), "--expected-version", version], {
        stdio: "inherit", env: { ...process.env, PALMAGENT_UPDATE_POST_UPGRADE: "1", ...(options.automatic ? { PALMAGENT_NON_INTERACTIVE: "1" } : {}) },
      });
      if (child.status !== 0) throw new Error("service activation or target health verification failed");
    },
    readPlugins: readPluginVersions, discoverPlugins, participatingPlugins,
    resolvePlan: resolveUpdatePlan, refreshPlugins, canonicalPluginPath: resolve,
  };
}
