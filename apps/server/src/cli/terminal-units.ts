import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { InstallConfig } from "./config.js";
import { quoteSystemd as quote } from "./systemd.js";
import { sudo, sudoWriteFile } from "./sh.js";

export function renderTerminalUnits(cfg: InstallConfig, launcher: string) {
  if (!cfg.executionNode || !cfg.pkgDir || cfg.user === "root" || ![cfg.user, cfg.group].every(v => /^[a-zA-Z0-9_.-]+$/.test(v))) throw new Error("Terminals require an unprivileged package installation");
  return {
    template: ["[Unit]", "Description=Palmagent terminal %i", "After=network.target", "",
      "[Service]", "Type=exec", `User=${cfg.user}`, `Group=${cfg.group}`,
      `Environment=${quote("PATH=" + cfg.execPath)}`,
      `ExecStart=${[cfg.executionNode, launcher, join(cfg.dataDir, "terminals")].map(arg => quote(arg.replace(/\$/g, () => "$$"))).join(" ")} %i`,
      "Restart=no", "KillMode=control-group", "TimeoutStopSec=5", "Slice=palmagent-terminals.slice", "UMask=0077", ""].join("\n"),
    slice: ["[Unit]", "Description=Palmagent terminal resource limits", "", "[Slice]",
      `MemoryHigh=${cfg.caps.memHigh}`, `MemoryMax=${cfg.caps.memMax}`, `TasksMax=${cfg.caps.tasksMaxRunner}`, `CPUQuota=${cfg.caps.cpuQuota}`, ""].join("\n"),
  };
}
export function installTerminalUnits(cfg: InstallConfig) {
  if (process.platform !== "linux") throw new Error("Terminal service installation is not supported on this platform");
  const source = join(cfg.pkgDir!, "terminal-launcher.js");
  const directory = join(cfg.dataDir, "launchers", createHash("sha256").update(readFileSync(source)).digest("hex"));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const launcher = join(directory, "terminal-launcher.mjs");
  if (!existsSync(launcher)) copyFileSync(source, launcher);
  const units = renderTerminalUnits(cfg, launcher);
  const helper = "/usr/local/libexec/palmagent-terminal-control";
  const script = '#!/bin/sh\nset -eu\n[ "$#" -eq 2 ] || exit 2\ncase "$1" in start|stop) ;; *) exit 2;; esac\n[ "${#2}" -eq 36 ] || exit 2\ncase "$2" in *[!0-9a-f-]*) exit 2;; esac\nexec /usr/bin/systemctl "$1" "palmagent-terminal@$2.service"\n';
  if (!sudo(["install", "-d", "-m", "0755", "/usr/local/libexec"]).ok || !sudoWriteFile(helper, script) || !sudo(["chmod", "0755", helper]).ok) throw new Error("Could not install terminal launcher");
  const candidate = "/etc/sudoers.d/.palmagent-terminals-candidate";
  if (!sudoWriteFile(candidate, `${cfg.user} ALL=(root) NOPASSWD: ${helper} *\n`) ||
      !sudo(["chmod", "0440", candidate]).ok || !sudo(["visudo", "-cf", candidate]).ok ||
      !sudo(["mv", "-f", candidate, "/etc/sudoers.d/palmagent-terminals"]).ok) throw new Error("Could not authorize terminal launcher");
  if (!sudoWriteFile("/etc/systemd/system/palmagent-terminal@.service", units.template) ||
      !sudoWriteFile("/etc/systemd/system/palmagent-terminals.slice", units.slice)) throw new Error("Could not install terminal services");
}
