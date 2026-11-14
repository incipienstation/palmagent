import { LocalAttachmentFiles } from "../modules/tasks/adapters/outbound/file-attachment-storage.js";
import { AttachmentMaintenanceDriver } from "../modules/tasks/adapters/inbound/attachment-maintenance.js";
import { createAttachmentMaintenance } from "../modules/tasks/application/use-cases/attachment-maintenance.js";
import { ATTACHMENT_DEFAULTS, type AttachmentPolicy } from "../modules/tasks/domain/attachment-policy.js";
import type { AttachmentIndex, AttachmentStorage } from "../modules/tasks/application/ports/outbound/attachments.js";

export function createAttachmentStorage(index: AttachmentIndex, policy: AttachmentPolicy = ATTACHMENT_DEFAULTS,
  now: () => number = () => Date.now()): AttachmentStorage {
  const files = new LocalAttachmentFiles(index, policy);
  const maintenance = new AttachmentMaintenanceDriver(createAttachmentMaintenance(index, files, policy, now), () => index.isOpen);
  return {
    save: (taskId, input) => files.save(taskId, input), read: (taskId, id) => files.read(taskId, id),
    load: (taskId, attachments) => files.load(taskId, attachments),
    start: () => maintenance.start(), close: () => maintenance.close(), prune: () => maintenance.prune(),
  };
}
