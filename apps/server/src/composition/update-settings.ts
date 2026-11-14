import { createUpdateAccess } from "../modules/installation/application/use-cases/update-access.js";
import { createUpdateSettings } from "../modules/installation/application/use-cases/update-settings.js";
import { createUpdateSettingsCommand } from "../modules/installation/adapters/inbound/update-settings-cli.js";
import { updateAccessStore, updateDiscoveryHost, createUpdateSettingsHost } from "../modules/installation/adapters/outbound/update-settings.js";
import { legacyUpdateTasksIdle } from "../modules/tasks/adapters/outbound/update-activity.js";
import type { UpdateAccessUseCases } from "../modules/installation/application/ports/inbound/update-settings-command.js";
import type { InstallConfig } from "../modules/installation/domain/installation.js";

export const updateAccess = createUpdateAccess(updateAccessStore, updateDiscoveryHost);
const host = createUpdateSettingsHost(legacyUpdateTasksIdle);
const settings = createUpdateSettings(updateAccessStore, updateDiscoveryHost, host, updateAccess);
export const { check: checkUpdateAccess, request: requestUpdateAccess, valid: validUpdateRequest, clear: clearUpdateRequest } = updateAccess;
export const { apply: applyUpdateSettings } = settings;
export function autoUpdateStatus(config: InstallConfig) {
  const { autoUpdate, ...status } = settings.read(config);
  return { enabled: autoUpdate, ...status };
}
export function runUpdateSettingsCommand(args: string[], check: UpdateAccessUseCases["check"] = updateAccess.check) {
  return createUpdateSettingsCommand(createUpdateSettings(updateAccessStore, updateDiscoveryHost, host, { ...updateAccess, check }))(args);
}
