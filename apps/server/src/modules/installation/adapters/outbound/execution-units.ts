import { join } from "node:path";
import type { InstallConfig } from "./config.js";
import { quoteSystemd as quote } from "./systemd.js";
import { retainLauncher, installServiceArtifacts, resourceSliceLimits } from "./service-artifacts.js";
import { HOST_ARTIFACTS } from "../../../../platform/process/host-artifacts.js";
const spec = HOST_ARTIFACTS.execution;

export function renderExecutionUnits(cfg: InstallConfig, launcher: string) {
  if (cfg.user === "root" || ![cfg.user, cfg.group].every(value => /^[a-zA-Z0-9_.-]+$/.test(value))) throw new Error("Independent executions require a valid unprivileged service owner");
  if (!cfg.executionNode || !cfg.pkgDir) throw new Error("Execution artifacts must be retained before rendering units");
  return {
    template: ["[Unit]", "Description=Palmagent independent execution %i", "After=network.target", "",
      "[Service]", "Type=exec", `User=${cfg.user}`, `Group=${cfg.group}`,
      `Environment=${quote(`PATH=${cfg.execPath}`)}`, `Environment=PALMAGENT_EXECUTION_CONCURRENCY=${cfg.concurrency}`,
      ...(cfg.claudeConfigDir ? [`Environment=${quote(`CLAUDE_CONFIG_DIR=${cfg.claudeConfigDir}`)}`] : []),
      `ExecStart=${[cfg.executionNode, launcher, join(cfg.dataDir, "executions")].map(arg => quote(arg.replace(/\$/g, () => "$$"))).join(" ")} %i`,
      "Restart=no", "KillMode=control-group", `Slice=${spec.sliceName}`, `LimitNOFILE=${cfg.caps.nofile}`, "",
    ].join("\n"),
    slice: ["[Unit]", "Description=Palmagent aggregate execution limits", "", "[Slice]",
      ...resourceSliceLimits(cfg.caps), ""].join("\n"),
  };
}
export function installExecutionUnits(cfg: InstallConfig) {
  const launcher = retainLauncher(cfg, spec);
  const units = renderExecutionUnits(cfg, launcher);
  const script = '#!/bin/sh\nset -eu\n[ "$#" -eq 1 ] || exit 2\n[ "${#1}" -eq 36 ] || exit 2\ncase "$1" in *[!0-9a-f-]*) exit 2;; esac\nexec /usr/bin/systemctl start --no-block "__UNIT__"\n'.replace('__UNIT__', spec.unitName('$1'));
  installServiceArtifacts(cfg, spec, units, script);
}
