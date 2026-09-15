import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { InstallConfig } from "./config.js";
import { quoteSystemd as quote } from "./systemd.js";
import { sudo, sudoWriteFile } from "./sh.js";

export function renderExecutionUnits(cfg: InstallConfig, launcher: string) {
  if (cfg.user === "root" || ![cfg.user, cfg.group].every(value => /^[a-zA-Z0-9_.-]+$/.test(value))) throw new Error("Independent executions require a valid unprivileged service owner");
  if (!cfg.executionNode || !cfg.pkgDir) throw new Error("Execution artifacts must be retained before rendering units");
  return {
    template: ["[Unit]", "Description=Palmagent independent execution %i", "After=network.target", "",
      "[Service]", "Type=exec", `User=${cfg.user}`, `Group=${cfg.group}`,
      `Environment=${quote(`PATH=${cfg.execPath}`)}`, `Environment=PALMAGENT_EXECUTION_CONCURRENCY=${cfg.concurrency}`,
      ...(cfg.claudeConfigDir ? [`Environment=${quote(`CLAUDE_CONFIG_DIR=${cfg.claudeConfigDir}`)}`] : []),
      `ExecStart=${[cfg.executionNode, launcher, join(cfg.dataDir, "executions")].map(arg => quote(arg.replace(/\$/g, () => "$$"))).join(" ")} %i`,
      "Restart=no", "KillMode=control-group", "Slice=palmagent-executions.slice", `LimitNOFILE=${cfg.caps.nofile}`, "",
    ].join("\n"),
    slice: ["[Unit]", "Description=Palmagent aggregate execution limits", "", "[Slice]",
      `MemoryHigh=${cfg.caps.memHigh}`, `MemoryMax=${cfg.caps.memMax}`, `TasksMax=${cfg.caps.tasksMaxRunner}`, `CPUQuota=${cfg.caps.cpuQuota}`, ""].join("\n"),
  };
}
export function installExecutionUnits(cfg: InstallConfig) {
  const source = join(cfg.pkgDir!, "execution-launcher.js");
  const digest = createHash("sha256").update(readFileSync(source)).digest("hex");
  const directory = join(cfg.dataDir, "launchers", digest);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const launcher = join(directory, "launcher.mjs");
  if (!existsSync(launcher)) copyFileSync(source, launcher);
  const units = renderExecutionUnits(cfg, launcher);
  if (!/^[a-zA-Z0-9_.-]+$/.test(cfg.user)) throw new Error("Invalid execution service owner");
  const helper = "/usr/local/libexec/palmagent-execution-start";
  const script = '#!/bin/sh\nset -eu\n[ "$#" -eq 1 ] || exit 2\n[ "${#1}" -eq 36 ] || exit 2\ncase "$1" in *[!0-9a-f-]*) exit 2;; esac\nexec /usr/bin/systemctl start --no-block "palmagent-execution@$1.service"\n';
  if (!sudo(["install", "-d", "-m", "0755", "/usr/local/libexec"]).ok || !sudoWriteFile(helper, script) || !sudo(["chmod", "0755", helper]).ok) throw new Error("Could not install the execution launch helper");
  const rule = `${cfg.user} ALL=(root) NOPASSWD: ${helper} *\n`;
  const candidateRule = "/etc/sudoers.d/.palmagent-executions-candidate";
  if (!sudoWriteFile(candidateRule, rule) || !sudo(["chmod", "0440", candidateRule]).ok || !sudo(["visudo", "-cf", candidateRule]).ok ||
      !sudo(["mv", "-f", candidateRule, "/etc/sudoers.d/palmagent-executions"]).ok) throw new Error("Could not authorize the bounded execution launcher");
  if (!sudoWriteFile("/etc/systemd/system/palmagent-execution@.service", units.template) ||
      !sudoWriteFile("/etc/systemd/system/palmagent-executions.slice", units.slice)) throw new Error("Could not install independent execution units");
}
