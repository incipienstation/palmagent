import { join } from "node:path";
import type { InstallConfig } from "./config.js";
import { quoteSystemd as quote } from "./systemd.js";
import { retainLauncher, installServiceArtifacts, resourceSliceLimits } from "./service-artifacts.js";
import { HOST_ARTIFACTS } from "../host-artifacts.js";
const spec = HOST_ARTIFACTS.terminal;

export function renderTerminalUnits(cfg: InstallConfig, launcher: string) {
  if (!cfg.executionNode || !cfg.pkgDir || cfg.user === "root" || ![cfg.user, cfg.group].every(v => /^[a-zA-Z0-9_.-]+$/.test(v))) throw new Error("Terminals require an unprivileged package installation");
  return {
    template: ["[Unit]", "Description=Palmagent terminal %i", "After=network.target", "",
      "[Service]", "Type=exec", `User=${cfg.user}`, `Group=${cfg.group}`,
      `Environment=${quote("PATH=" + cfg.execPath)}`,
      `ExecStart=${[cfg.executionNode, launcher, join(cfg.dataDir, "terminals")].map(arg => quote(arg.replace(/\$/g, () => "$$"))).join(" ")} %i`,
      "Restart=no", "KillMode=control-group", "TimeoutStopSec=5", `Slice=${spec.sliceName}`, "UMask=0077", ""].join("\n"),
    slice: ["[Unit]", "Description=Palmagent terminal resource limits", "", "[Slice]",
      ...resourceSliceLimits(cfg.caps), ""].join("\n"),
  };
}
export function installTerminalUnits(cfg: InstallConfig) {
  if (process.platform !== "linux") throw new Error("Terminal service installation is not supported on this platform");
  const launcher = retainLauncher(cfg, spec);
  const units = renderTerminalUnits(cfg, launcher);
  const script = '#!/bin/sh\nset -eu\n[ "$#" -eq 2 ] || exit 2\ncase "$1" in start|stop) ;; *) exit 2;; esac\n[ "${#2}" -eq 36 ] || exit 2\ncase "$2" in *[!0-9a-f-]*) exit 2;; esac\nexec /usr/bin/systemctl "$1" "__UNIT__"\n'.replace('__UNIT__', spec.unitName('$2'));
  installServiceArtifacts(cfg, spec, units, script);
}
