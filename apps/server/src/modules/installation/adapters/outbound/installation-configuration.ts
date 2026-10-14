import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { InstallationConfiguration } from "../../application/ports/outbound/installation.js";
import type { InstallationOptions } from "../../application/ports/inbound/installation-use-cases.js";
import { callerPkgDir, resolveDataDir, loadConfig, saveConfig, validateInstallInput, authFromDomain, assertSafePurgeTarget, type InstallConfig } from "./config.js";
import { getUserConfig, setUserChannel, initUserConfig, assertUserConfigPreserved } from "./user-config.js";
import { productVersion } from "../../domain/release-policy.js";
import { userServiceDirectory } from "./user-service.js";
import { installedVersion } from "./installation-releases.js";
import { ask } from "./sh.js";

function detectRuntime(): {
  mode: "package" | "source";
  pkgDir?: string;
  repoDir?: string;
} {
  const dir = callerPkgDir();
  if (existsSync(join(dir, "server.js")))
    return { mode: "package", pkgDir: dir };
  // Source helper lives under apps/server/src/modules/installation/adapters/outbound.
  const repoDir = resolve(dir, "..", "..", "..", "..", "..", "..", "..");
  if (existsSync(join(repoDir, "apps", "server", "package.json")))
    return { mode: "source", repoDir };
  return { mode: "package", pkgDir: dir };
}


async function gatherConfig(
  options: InstallationOptions,
  requireInstalled = false,
): Promise<InstallConfig> {
  const rt = detectRuntime();
  const dataDir = resolveDataDir(options.dataDir);
  // Start from any existing config (so re-runs are idempotent), then override.
  const base = loadConfig({
    dataDir,
    pkgDir: rt.pkgDir,
    requireInstalled,
  });

  const domainInput =
    options.domain ??
    (!options.interactive
      ? base.domain
      : await ask("Public domain (e.g. dispatch.example.com)", base.domain));
  if (!domainInput) {
    throw new Error(
      "a public domain is required — pass --domain or enter it at the prompt (no default).",
    );
  }
  const portInput = Number(
    options.port ??
      (!options.interactive
        ? base.port
        : await ask("Internal port", String(base.port))),
  );
  const concurrencyInput = Number(
    options.concurrency ??
      (!options.interactive
        ? base.concurrency
        : await ask("Max concurrent turns", String(base.concurrency))),
  );
  const repoRoots =
    options.repoRoots ??
    (!options.interactive
      ? base.repoRoots
      : await ask(
          "Repo scan roots (colon-separated, blank = automatic search off)",
          base.repoRoots,
        ));
  const claudeConfigDir =
    options.claudeConfigDir ??
    (!options.interactive
      ? base.claudeConfigDir
      : await ask(
          "Claude CLI config dir (CLAUDE_CONFIG_DIR, blank = ~/.claude default)",
          base.claudeConfigDir,
        ));
  const input = validateInstallInput({
    domain: domainInput,
    host: options.host ?? base.host,
    port: portInput,
    concurrency: concurrencyInput,
    pushSubject: options.pushSubject ?? base.pushSubject,
  });

  const requestedChannel = options.channel;
  const selectedChannel = requestedChannel !== undefined
    ? setUserChannel(requestedChannel, { dryRun: true }).channel
    : getUserConfig({ dataDir }).channel;
  if (!requireInstalled && rt.mode === "package" && selectedChannel === "stable" &&
      productVersion(installedVersion(rt.pkgDir)).prerelease) {
    throw new Error("this is a Preview build; opt in with --channel preview or install a published Stable release");
  }

  if (base.executionNode && rt.mode !== "package") throw new Error("An independent package installation cannot be switched to a source runtime through setup");
  const cfg: InstallConfig = {
    ...base,
    releaseChannel: selectedChannel,
    mode: rt.mode,
    pkgDir: rt.pkgDir,
    repoDir: rt.repoDir,
    workingDir:
      rt.mode === "source" ? join(rt.repoDir!, "apps", "server") : rt.pkgDir!,
    dataDir,
    runnerSocket: join(dataDir, "runner.sock"),
    dbPath: base.dbPath,
    domain: input.domain,
    host: input.host,
    port: input.port,
    concurrency: input.concurrency,
    pushSubject: input.pushSubject,
    repoRoots,
    claudeConfigDir,
    ...authFromDomain(input.domain),
    supervisor: base.supervisor ?? (rt.mode === "package" && rt.pkgDir && existsSync(join(rt.pkgDir, "daemon", "manifest.json")) ? "palmagentd" : undefined),
  };
  if (cfg.supervisor === "palmagentd") {
    cfg.daemonScope = "user";
    cfg.daemonUnitDir = base.daemonUnitDir ?? userServiceDirectory();
  }
  return cfg;
}


function persistUserChannel(cfg: InstallConfig, explicitlySelected: boolean): void {
  if (explicitlySelected) setUserChannel(cfg.releaseChannel!);
  else initUserConfig({ dataDir: cfg.dataDir });
}

export const installationConfiguration: InstallationConfiguration = {
  exists: dataDir => existsSync(join(resolveDataDir(dataDir), "install.env")),
  load: dataDir => loadConfig({ dataDir, requireInstalled: true }),
  resolve: gatherConfig, save: saveConfig,
  preferences: dataDir => getUserConfig({ dataDir }),
  persistChannel: persistUserChannel,
  initializePreferences: dataDir => { initUserConfig({ dataDir }); },
  assertPurgeTarget(dataDir) { assertSafePurgeTarget(dataDir); assertUserConfigPreserved(dataDir); },
};
