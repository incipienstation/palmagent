import type { AttachmentIndex } from "../../application/ports/outbound/attachments.js";
import type { AttachmentRecord } from "../../domain/models.js";

/** File access and collection use the same native index transaction as creation. */
export class NativeAttachmentIndex implements AttachmentIndex {
  isOpen = true;
  constructor(readonly path: string, private readonly command: (body: object) => unknown,
    readonly transaction: AttachmentIndex["transaction"]) {}

  private files(command: object) { return this.command({ kind: "files", command }); }
  attachment(taskId: string, id: string) {
    return this.files({ kind: "get", taskId, id }) as AttachmentRecord | null ?? undefined;
  }
  attachmentByDigest(taskId: string, digest: string) {
    return this.files({ kind: "digest", taskId, digest }) as AttachmentRecord | null ?? undefined;
  }
  registerDeliveredImage(taskId: string, path: string, id: string) { this.files({ kind: "registerDelivery", taskId, path, id }); }
  deliveredImageId(taskId: string, path: string) {
    return this.files({ kind: "deliveredImage", taskId, path }) as string | null ?? undefined;
  }
  insertAttachment(record: AttachmentRecord) { this.files({ kind: "insert", ...record }); }
  setAttachmentLifecycle(id: string, unusedSince: number | null, expiredAt: number | null) {
    this.files({ kind: "lifecycle", id, unusedSince, expiredAt });
  }
  deleteAttachment(id: string) { this.files({ kind: "delete", id }); }
  attachmentInventory() { return this.files({ kind: "inventory" }) as ReturnType<AttachmentIndex["attachmentInventory"]>; }
  attachmentReferences(taskId: string) {
    const refs = this.files({ kind: "references", taskId }) as { history: string[]; pending: string[] };
    return { history: new Set(refs.history), pending: new Set(refs.pending) };
  }
}
