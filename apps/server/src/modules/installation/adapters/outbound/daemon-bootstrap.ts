/** Linux boot/crash recovery adapter; never used by normal runtime activation. */
import { copyFileSync, chmodSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ensurePrivateDirectory, writePrivateFileAtomic } from "../../../../platform/filesystem/private-files.js";
import { daemonRequest } from "../../../../platform/process/daemon-client.js";
import type { InstallConfig } from "./config.js";
import { daemonBinary } from "./daemon-runtime.js";
import { run, sudo, sudoWriteFile } from "./sh.js";
import { assertInstallationOwner, daemonServiceName, userSystemctl } from "./user-service.js";

export const daemonUnit = "palmagentd.service";

function control(cfg: InstallConfig, args: string[], mutate = false) {
  return cfg.daemonScope === "user" ? userSystemctl(args) : mutate ? sudo(["systemctl", ...args]) : run("systemctl", args);
}

export function daemonUnitPath(cfg: InstallConfig): string {
  if (cfg.daemonScope === "user" && !cfg.daemonUnitDir) throw new Error("User service directory is missing");
  return join(cfg.daemonScope === "user" ? cfg.daemonUnitDir! : "/etc/systemd/system", daemonServiceName(cfg));
}

export function assertDaemonBootstrapSupported(): void {
  const version = run("systemctl", ["--version"]);
  if (!version.ok || Number(/^systemd (\d+)/.exec(version.stdout)?.[1] ?? 0) < 254) {
    throw new Error("The Linux daemon bootstrap requires systemd 254 or newer for delegated crash recovery");
  }
}

export function installDaemonBootstrap(cfg: InstallConfig, enable = true): void {
  assertInstallationOwner(cfg);
  assertDaemonBootstrapSupported();
  const binary = daemonBinary(cfg.pkgDir!);
  const launcher = join(cfg.dataDir, "daemon", "launcher");
  ensurePrivateDirectory(dirname(launcher));
  // The bootstrap ABI remains v1. Keep this launcher immutable across application updates.
  if (!existsSync(launcher)) {
    copyFileSync(binary, launcher + ".tmp"); chmodSync(launcher + ".tmp", 0o700); renameSync(launcher + ".tmp", launcher);
  }
  const rendered = run(binary, ["bootstrap-unit", "--data-dir", cfg.dataDir, "--launcher", launcher, "--user", cfg.user, "--group", cfg.group, "--scope", cfg.daemonScope ?? "system"]);
  if (!rendered.ok) throw new Error("Could not render the daemon bootstrap");
  const path = daemonUnitPath(cfg), unit = daemonServiceName(cfg);
  if (cfg.daemonScope === "user") {
    const marker = `# Palmagent managed user service: ${unit}\n`;
    if (existsSync(path) && !readFileSync(path, "utf8").startsWith(marker)) throw new Error("Refusing to overwrite an unmanaged user service");
    writePrivateFileAtomic(path, marker + rendered.stdout);
  } else if (!sudoWriteFile(path, rendered.stdout)) throw new Error("Could not write the system daemon bootstrap");
  if (!control(cfg, ["daemon-reload"], true).ok) throw new Error("Could not reload the daemon bootstrap");
  if (cfg.daemonScope === "user") {
    const loaded = control(cfg, ["show", unit, "--property=FragmentPath", "--value"]);
    if (!loaded.ok || loaded.stdout.trim() !== path) throw new Error("User manager did not load the expected Palmagent service file");
  }
  if (enable && !control(cfg, ["enable", unit], true).ok) {
    throw new Error("Could not register the daemon bootstrap");
  }
}

export function startDaemonBootstrap(cfg: InstallConfig): void {
  if (!control(cfg, ["start", daemonServiceName(cfg)], true).ok) throw new Error("Could not start the daemon bootstrap");
}

export function stopDaemonBootstrap(cfg: InstallConfig): void {
  assertInstallationOwner(cfg);
  if (cfg.daemonScope === "user") {
    const path = daemonUnitPath(cfg);
    if (existsSync(path) && !readFileSync(path, "utf8").startsWith(`# Palmagent managed user service: ${daemonServiceName(cfg)}\n`)) {
      throw new Error("Refusing to stop an unmanaged user service");
    }
    const loaded = control(cfg, ["show", daemonServiceName(cfg), "--property=FragmentPath", "--value"]);
    if (!loaded.ok || (loaded.stdout.trim() && loaded.stdout.trim() !== path)) throw new Error("Cannot verify the installed user service path");
  }
  const unit = daemonServiceName(cfg);
  let emptyGroup: string | undefined;
  try { daemonRequest(cfg.dataDir, { action: "stop" }); }
  catch (error) {
    // A failed first start has no control endpoint. Only an empty bootstrap may
    // be removed without its acknowledgment; active or uncertain hosts are retained.
    const group = control(cfg, ["show", unit, "--property=ControlGroup", "--value"]);
    if (!group.ok) throw error;
    const relative = group.stdout.trim();
    if (relative) {
      const path = resolve("/sys/fs/cgroup", "." + relative);
      if (!path.startsWith("/sys/fs/cgroup/") || !path.endsWith("/" + unit)) throw error;
      if (existsSync(join(path, "cgroup.events")) && !readFileSync(join(path, "cgroup.events"), "utf8").includes("populated 0")) throw error;
      emptyGroup = path;
    }
  }
  if (!control(cfg, ["disable", "--now", unit], true).ok) throw new Error("Could not stop the daemon bootstrap");
  if (emptyGroup && existsSync(join(emptyGroup, "cgroup.events")) && !readFileSync(join(emptyGroup, "cgroup.events"), "utf8").includes("populated 0")) {
    throw new Error("Bootstrap became populated during shutdown; retain its artifacts for recovery");
  }
}

/** Remove only the recorded scope. A user uninstall never cleans system services
 * or disables linger, which may be shared by unrelated applications. */
export function removeDaemonRegistration(cfg: InstallConfig): void {
  const path = daemonUnitPath(cfg);
  assertInstallationOwner(cfg);
  if (cfg.daemonScope === "user" && existsSync(path) && !readFileSync(path, "utf8").startsWith(`# Palmagent managed user service: ${daemonServiceName(cfg)}\n`)) {
    throw new Error("Refusing to remove an unmanaged user service");
  }
  if (!control(cfg, ["disable", daemonServiceName(cfg)], true).ok) throw new Error("Could not disable the daemon bootstrap");
  if (cfg.daemonScope === "user") rmSync(path, { force: true });
  else if (!sudo(["rm", "-f", path]).ok) throw new Error("Could not remove the daemon bootstrap");
  if (!control(cfg, ["daemon-reload"], true).ok) {
    throw new Error("Could not remove the daemon bootstrap");
  }
}

export function restoreDaemonBootstrap(cfg: InstallConfig): void {
  if (!control(cfg, ["enable", daemonServiceName(cfg)], true).ok) throw new Error("Could not restore the previous daemon bootstrap");
  startDaemonBootstrap(cfg);
}

export function removeDaemonBootstrap(cfg: InstallConfig): void {
  stopDaemonBootstrap(cfg);
  removeDaemonRegistration(cfg);
}
