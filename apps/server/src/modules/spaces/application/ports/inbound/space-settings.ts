import type { RepoSettings, RepoSettingsChange } from "@palmagent/shared";

/** Operations accepted by the spaces module. */
export interface SpaceSettings {
  get(): RepoSettings;
  change(input: RepoSettingsChange, dryRun?: boolean): RepoSettings;
}
