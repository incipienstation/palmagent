/** Linux boot/crash recovery adapter; never used by normal runtime activation. */
import { copyFileSync, chmodSync, existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
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
  daemonRequest(cfg.dataDir, { action: "stop" });
  if (!sudo(["systemctl", "disable", "--now", daemonUnit]).ok ||
      !sudo(["rm", "-f", join("/etc/systemd/system", daemonUnit)]).ok || !sudo(["systemctl", "daemon-reload"]).ok) {
    throw new Error("Could not remove the daemon bootstrap");
  }
}
