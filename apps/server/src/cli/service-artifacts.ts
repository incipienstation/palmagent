import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { HostArtifacts } from "../host-artifacts.js";
import type { InstallConfig, ResourceCaps } from "./config.js";
import { sudo, sudoWriteFile } from "./sh.js";

export function retainLauncher(cfg: InstallConfig, spec: HostArtifacts): string {
  if (!cfg.pkgDir || !cfg.executionNode) throw new Error("Retained execution artifacts are required");
  const source = join(cfg.pkgDir, spec.sourceLauncher);
  const directory = join(cfg.dataDir, "launchers", createHash("sha256").update(readFileSync(source)).digest("hex"));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const launcher = join(directory, spec.retainedLauncher);
  if (!existsSync(launcher)) copyFileSync(source, launcher);
  return launcher;
}
export function resourceSliceLimits(caps: ResourceCaps): string[] {
  return [`MemoryHigh=${caps.memHigh}`, `MemoryMax=${caps.memMax}`, `TasksMax=${caps.tasksMaxRunner}`, `CPUQuota=${caps.cpuQuota}`];
}
export function installServiceArtifacts(cfg: InstallConfig, spec: HostArtifacts,
  units: { template: string; slice: string }, helperScript: string): void {
  if (cfg.user === "root" || !/^[a-zA-Z0-9_.-]+$/.test(cfg.user)) throw new Error("Invalid unprivileged service owner");
  if (!sudo(["install", "-d", "-m", "0755", dirname(spec.helperPath)]).ok ||
      !sudoWriteFile(spec.helperPath, helperScript) || !sudo(["chmod", "0755", spec.helperPath]).ok) {
    throw new Error(`Could not install ${spec.kind} launcher`);
  }
  const rule = `${cfg.user} ALL=(root) NOPASSWD: ${spec.helperPath} *\n`;
  if (!sudoWriteFile(spec.candidatePath, rule) || !sudo(["chmod", "0440", spec.candidatePath]).ok ||
      !sudo(["visudo", "-cf", spec.candidatePath]).ok || !sudo(["mv", "-f", spec.candidatePath, spec.sudoersPath]).ok) {
    throw new Error(`Could not authorize ${spec.kind} launcher`);
  }
  if (!sudoWriteFile(spec.templatePath, units.template) || !sudoWriteFile(spec.slicePath, units.slice)) {
    throw new Error(`Could not install ${spec.kind} services`);
  }
}
