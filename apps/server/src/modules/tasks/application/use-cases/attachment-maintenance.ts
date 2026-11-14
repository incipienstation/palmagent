import { attachmentRetention, type AttachmentPolicy, type AttachmentReferences } from "../../domain/attachment-policy.js";
import type { AttachmentMaintenance } from "../ports/inbound/attachment-maintenance.js";
import type { AttachmentFileCollection, AttachmentRetentionRepository } from "../ports/outbound/attachments.js";

export function createAttachmentMaintenance(index: AttachmentRetentionRepository, files: AttachmentFileCollection,
  policy: AttachmentPolicy, now: () => number): AttachmentMaintenance {
  return {
    prune() {
      // Persist expiration before unlinking; a failed sweep must not restore access.
      index.transaction(() => {
        const at = now();
        const references = new Map<string, AttachmentReferences>();
        for (const record of index.attachmentInventory()) {
          if (record.expiredAt !== null) continue;
          let refs = references.get(record.taskId);
          if (!refs) { refs = index.attachmentReferences(record.taskId); references.set(record.taskId, refs); }
          const decision = attachmentRetention(record, refs, policy, at);
          if (decision?.kind === "delete") index.deleteAttachment(record.id);
          else if (decision?.kind === "update") index.setAttachmentLifecycle(record.id, decision.unusedSince, decision.expiredAt);
        }
      });
      if (!files.exists()) return;
      // An upload may have restored content after marking. Re-read under the same
      // writer lock used by uploads, and hold it until physical deletion finishes.
      index.transaction(() => {
        const retained = new Set(index.attachmentInventory().filter(record => record.expiredAt === null).map(record => record.id));
        files.removeUnreferenced(retained);
      });
    },
  };
}
