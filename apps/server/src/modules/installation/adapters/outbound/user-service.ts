/** User-manager integration for installation and diagnostics, never runtime execution. */
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { writePrivateFileAtomic } from "../../../../platform/filesystem/private-files.js";
import type { InstallConfig } from "./config.js";
import { daemonBinary, daemonConfiguration } from "./daemon-runtime.js";
import { run, type RunResult } from "./sh.js";

export function userServiceDirectory(): string {
  const root = process.env.XDG_CONFIG_HOME || join(userInfo().homedir, ".config");
  if (!isAbsolute(root)) throw new Error("XDG_CONFIG_HOME must be an absolute directory");
  return join(root, "systemd", "user");
}

export function daemonServiceName(cfg: InstallConfig): string {
  return cfg.daemonScope === "user"
    ? `palmagentd-${createHash("sha256").update(resolve(cfg.dataDir)).digest("hex").slice(0, 16)}.service`
    : "palmagentd.service";
}

export function userServiceEnvironment(): NodeJS.ProcessEnv {
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) throw new Error("User services require a non-root Linux installation owner");
  // A shell may be attached to a private login/keyring bus. Service management
  // must always address this UID's standard systemd user manager instead.
  const env = { ...process.env };
  delete env.SYSTEMD_BUS_ADDRESS;
  delete env.SYSTEMD_BUS_TIMEOUT;
  return { ...env, XDG_RUNTIME_DIR: `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` };
}

export function userSystemctl(args: string[]): RunResult {
  return run("systemctl", ["--user", "--no-ask-password", ...args], { env: userServiceEnvironment(), timeout: 15_000 });
}

export function assertInstallationOwner(cfg: InstallConfig): void {
  if (cfg.user === "root" || cfg.user !== userInfo().username) throw new Error("Run this command as the installation owner, without sudo");
}

export function lingerEnabled(cfg: InstallConfig): boolean {
  assertInstallationOwner(cfg);
  const result = run("loginctl", ["show-user", cfg.user, "--property=Linger", "--value"], { timeout: 5_000 });
  if (!result.ok || !["yes", "no"].includes(result.stdout.trim())) {
    throw new Error("Cannot inspect user lingering; systemd-logind and a registered user manager are required");
  }
  return result.stdout.trim() === "yes";
}

export function prepareUserService(cfg: InstallConfig, dryRun = false): void {
  const enabled = lingerEnabled(cfg);
  if (!enabled && !dryRun) {
    const result = run("loginctl", ["--no-ask-password", "enable-linger", cfg.user], { timeout: 10_000 });
    if (!result.ok || !lingerEnabled(cfg)) {
      throw new Error("User lingering could not be enabled without administrator authentication; ask the host administrator to allow lingering for this account");
    }
  }
  let manager = userSystemctl(["show", "--property=Version", "--value"]);
  // logind can return before the newly enabled user manager has opened its bus.
  for (let attempt = 0; !manager.ok && !dryRun && attempt < 20; attempt++) {
    run("sleep", ["0.1"]);
    manager = userSystemctl(["show", "--property=Version", "--value"]);
  }
  if (!manager.ok || Number(/^(\d+)/.exec(manager.stdout.trim())?.[1] ?? 0) < 254) {
    throw new Error("An accessible systemd user manager version 254 or newer is required; start a normal login session and check systemctl --user status");
  }
  if (!cfg.daemonUnitDir || !isAbsolute(cfg.daemonUnitDir)) throw new Error("The user service directory is missing from the installation configuration");
  const paths = userSystemctl(["show", "--property=UnitPath", "--value"]);
  if (!paths.ok || !paths.stdout.trim().split(/\s+/).includes(cfg.daemonUnitDir)) {
    throw new Error("The configured user service directory is not searched by this user manager; align XDG_CONFIG_HOME before installation");
  }
}

/** Exercise the same native cgroup operations as the daemon, in a disposable
 * user service. No old runtime/configuration is changed if delegation fails. */
export function verifyUserIsolation(cfg: InstallConfig): void {
  const configuration = daemonConfiguration(cfg);
  const root = mkdtempSync(join(tmpdir(), "palmagent-user-isolation-"));
  const unit = `palmagent-isolation-${randomUUID()}.service`;
  try {
    writePrivateFileAtomic(join(root, "daemon/config.json"), JSON.stringify(configuration));
    const probe = run("systemd-run", ["--user", "--no-ask-password", "--wait", "--pipe", "--collect", "--quiet", `--unit=${unit}`,
      "--property=Delegate=cpu memory pids", "--property=DelegateSubgroup=control", "--property=RuntimeMaxSec=15",
      daemonBinary(cfg.pkgDir!), "check-isolation", "--data-dir", root,
    ], { env: userServiceEnvironment(), timeout: 20_000 });
    if (!probe.ok || probe.stdout.trim() !== "delegated-isolation-ready") {
      throw new Error("User-service isolation is unavailable: writable cgroup v2 with cpu, memory, pids and cgroup.kill is required; no service was migrated");
    }
  } finally {
    // Only this probe's random unit is touched, including after a client timeout.
    userSystemctl(["stop", unit]);
    userSystemctl(["reset-failed", unit]);
    rmSync(root, { recursive: true, force: true });
  }
}
