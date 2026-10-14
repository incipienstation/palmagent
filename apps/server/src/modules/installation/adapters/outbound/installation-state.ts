import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InstallationState } from "../../application/ports/outbound/installation.js";
import { writePrivateFileAtomic } from "../../../../platform/filesystem/private-files.js";
import { acquireUpdateLock, readUpdateReceipt, writeUpdateReceipt } from "./update-state.js";
import { beginUpdateMaintenance, updateMaintenanceOwnedBy } from "./update-maintenance.js";
import { clearUpdateRequest, validUpdateRequest, readUpdateAccess, writeUpdateAccess } from "./update-access.js";
import { userConfigPath } from "./user-config.js";

export const installationState: InstallationState = {
  lock: () => acquireUpdateLock(dirname(userConfigPath())),
  beginMaintenance: config => beginUpdateMaintenance(config.dbPath),
  parentOwnsMaintenance: config => updateMaintenanceOwnedBy(config.dbPath, process.ppid),
  readUpdate: readUpdateReceipt, writeUpdate: writeUpdateReceipt,
  clearDiscovery: dataDir => writeUpdateAccess(dataDir, { ...readUpdateAccess(dataDir), discovery: null }),
  validRequest: validUpdateRequest, clearRequest: clearUpdateRequest,
  readMigration(config) {
    const file = join(config.dataDir, "daemon-migration.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  },
  writeMigration: (config, receipt) => writePrivateFileAtomic(join(config.dataDir, "daemon-migration.json"), JSON.stringify(receipt) + "\n"),
  clearMigration: config => rmSync(join(config.dataDir, "daemon-migration.json"), { force: true }),
  writeActivation: (config, receipt) => writePrivateFileAtomic(join(config.dataDir, "application-activation.json"), JSON.stringify(receipt) + "\n"),
};
