import type { InstallConfig } from "./installation.js";
import type { PluginVersion } from "./update-plan.js";

export interface NativePlugin extends PluginVersion {
  manager: "codex" | "claude";
  home: string;
  scope: string;
  cwd: string;
  enabled: boolean;
  policy?: string;
}
export interface ApplicationIdentity {
  version: string;
  sourceCommit: string;
  files: Record<string, string>;
}
export type Level = "ok" | "warn" | "fail";
export interface Check {
  name: string;
  level: Level;
  detail: string;
  fix?: string;
}

export interface MigrationReceipt { previous: InstallConfig; target: InstallConfig; previousDaemonConfig?: string }
export interface ActivationReceipt { previous: InstallConfig; target: InstallConfig; status: "applying" | "succeeded" | "restored" | "recovery-required"; verification?: ApplicationIdentity }
export interface RuntimeActivity { verified: boolean; healthy?: boolean; maintenance?: boolean; executionProtocol?: number; activeRoutineScripts?: number; updateBlockingRoutineScripts?: number }
