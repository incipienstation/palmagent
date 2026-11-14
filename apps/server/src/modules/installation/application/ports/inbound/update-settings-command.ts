import type { Distribution } from "@palmagent/shared/standalone";
import type { UpdateRequest, UpdateSettingsChange, UpdateSettingsCommandResult, UpdateSettingsState } from "@palmagent/shared/updates";
import type { InstallConfig } from "../../../domain/installation.js";
import type { UpdateAccessState } from "../../../domain/update-access.js";

export interface UpdateAccessUseCases {
  check(config: InstallConfig, force: boolean, now?: number, distribution?: Distribution): UpdateAccessState;
  request(config: InstallConfig, automatic: boolean, version?: string): void;
  valid(config: InstallConfig, request: UpdateRequest): boolean;
  clear(config: InstallConfig, id?: string): void;
  paused(config: InstallConfig): boolean;
}
export type UpdateSettingsCommand = { dataDir: string; expectedDb: string } & (
  { action: "status" | "visit" | "check" | "migrate" | "resume" } |
  { action: "set"; change: UpdateSettingsChange } | { action: "install"; target: string }
);
export interface UpdateSettingsCommands {
  execute(command: UpdateSettingsCommand): Promise<UpdateSettingsCommandResult>;
  read(config: InstallConfig): NonNullable<UpdateSettingsState["settings"]>;
  apply(config: InstallConfig, change: UpdateSettingsChange, dryRun?: boolean): Promise<void>;
}
