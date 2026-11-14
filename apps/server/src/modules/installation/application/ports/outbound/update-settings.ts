import type { Distribution } from "@palmagent/shared/standalone";
import type { UpdateChannel, UpdateDiscoveryFailure, UpdateReceipt, UpdateSettingsState } from "@palmagent/shared/updates";
import type { InstallConfig } from "../../../domain/installation.js";
import type { UpdateAccessState } from "../../../domain/update-access.js";
import type { UpdatePlan } from "../../../domain/update-plan.js";

export interface UpdateAccessStore {
  read(dataDir: string): UpdateAccessState;
  write(dataDir: string, state: UpdateAccessState): void;
  receipt(dataDir: string): UpdateReceipt | undefined;
}
export interface UpdatePreferences { channel: UpdateChannel; autoUpdate?: boolean }
export interface UpdateDiscoveryHost {
  preferences(dataDir: string): UpdatePreferences;
  version(config: InstallConfig): string;
  distribution(config: InstallConfig): Distribution;
  discover(config: InstallConfig, current: string, channel: UpdateChannel, distribution?: Distribution):
    { ok: true; plan: UpdatePlan } | { ok: false; failure: UpdateDiscoveryFailure };
  now(): number;
  requestId(): string;
}
export interface UpdateSettingsHost {
  /** Busy is a normal refusal; other storage failures throw. */
  lock(): (() => void) | undefined;
  installation(dataDir: string, expectedDb: string): { cfg?: InstallConfig; availability: UpdateSettingsState["availability"] };
  setChannel(config: InstallConfig, channel: UpdateChannel, dryRun: boolean): void;
  configureAutomatic(config: InstallConfig, enabled: boolean, dryRun: boolean): Promise<void>;
  retireTimer(): void;
  legacyTasksIdle(database: string): boolean;
  prepare(config: InstallConfig): Promise<void>;
  start(config: InstallConfig): Promise<void>;
}
