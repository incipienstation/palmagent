/** Linux boot/crash recovery adapter; never used by normal runtime activation. */
import { copyFileSync, chmodSync, existsSync, readFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ensurePrivateDirectory } from "../../../../platform/filesystem/private-files.js";
import { daemonRequest } from "../../../../platform/process/daemon-client.js";
import type { InstallConfig } from "./config.js";
import { daemonBinary } from "./daemon-runtime.js";
import { run, sudo, sudoWriteFile } from "./sh.js";

export const daemonUnit = "palmagentd.service";

export function assertDaemonBootstrapSupported(): void {
  const version = run("systemctl", ["--version"]);
  if (!version.ok || Number(/^systemd (\d+)/.exec(version.stdout)?.[1] ?? 0) < 254) {
    throw new Error("The Linux daemon bootstrap requires systemd 254 or newer for delegated crash recovery");
  }
}

export function installDaemonBootstrap(cfg: InstallConfig): void {
  assertDaemonBootstrapSupported();
  const binary = daemonBinary(cfg.pkgDir!);
  const launcher = join(cfg.dataDir, "daemon", "launcher");
  ensurePrivateDirectory(dirname(launcher));
  // The bootstrap ABI remains v1. Keep this launcher immutable across application updates.
  if (!existsSync(launcher)) {
    copyFileSync(binary, launcher + ".tmp"); chmodSync(launcher + ".tmp", 0o700); renameSync(launcher + ".tmp", launcher);
  }
  const rendered = run(binary, ["bootstrap-unit", "--data-dir", cfg.dataDir, "--launcher", launcher, "--user", cfg.user, "--group", cfg.group]);
  if (!rendered.ok || !sudoWriteFile(join("/etc/systemd/system", daemonUnit), rendered.stdout) ||
      !sudo(["systemctl", "daemon-reload"]).ok || !sudo(["systemctl", "enable", daemonUnit]).ok) {
    throw new Error("Could not register the daemon bootstrap");
  }
}

export function startDaemonBootstrap(): void {
  if (!sudo(["systemctl", "start", daemonUnit]).ok) throw new Error("Could not start the daemon bootstrap");
}

export function removeDaemonBootstrap(cfg: InstallConfig): void {
  let emptyGroup: string | undefined;
  try { daemonRequest(cfg.dataDir, { action: "stop" }); }
  catch (error) {
    // A failed first start has no control endpoint. Only an empty bootstrap may
    // be removed without its acknowledgment; active or uncertain hosts are retained.
    const group = run("systemctl", ["show", daemonUnit, "--property=ControlGroup", "--value"]);
    if (!group.ok) throw error;
    const relative = group.stdout.trim();
    if (relative) {
      const path = resolve("/sys/fs/cgroup", "." + relative);
      if (!path.startsWith("/sys/fs/cgroup/") || !path.endsWith("/" + daemonUnit)) throw error;
      if (existsSync(join(path, "cgroup.events")) && !readFileSync(join(path, "cgroup.events"), "utf8").includes("populated 0")) throw error;
      emptyGroup = path;
    }
  }
  if (!sudo(["systemctl", "disable", "--now", daemonUnit]).ok) throw new Error("Could not stop the daemon bootstrap");
  if (emptyGroup && existsSync(join(emptyGroup, "cgroup.events")) && !readFileSync(join(emptyGroup, "cgroup.events"), "utf8").includes("populated 0")) {
    throw new Error("Bootstrap became populated during shutdown; retain its artifacts for recovery");
  }
  if (!sudo(["rm", "-f", join("/etc/systemd/system", daemonUnit)]).ok || !sudo(["systemctl", "daemon-reload"]).ok) {
    throw new Error("Could not remove the daemon bootstrap");
  }
}
