import type { InputAttachment } from "@palmagent/shared";
import type { Attachment } from "@palmagent/shared";
import type { AttachmentRecord } from "../../../domain/models.js";

export interface AttachmentIndex {
  readonly path: string;
  readonly isOpen: boolean;
  transaction<T>(work: () => T): T;
  attachment(taskId: string, id: string): AttachmentRecord | undefined;
  attachmentByDigest(taskId: string, digest: string): AttachmentRecord | undefined;
  insertAttachment(record: AttachmentRecord): void;
  attachmentInventory(): (AttachmentRecord & { status: string; updatedAt: number })[];
  attachmentReferences(taskId: string): { history: Set<string>; pending: Set<string> };
  deleteAttachment(id: string): void;
  setAttachmentLifecycle(id: string, unusedSince: number | null, expiredAt: number | null): void;
}

export interface AttachmentStorage {
  start(): void;
  close(): void;
  prune(): void;
  save(taskId: string, images?: readonly InputAttachment[]): Attachment[] | undefined;
  read(taskId: string, id: string): { bytes: Uint8Array; mediaType: string };
  load(taskId: string, attachments?: readonly Attachment[]): InputAttachment[] | undefined;
}

export interface TaskAttachmentReader {
  read(taskId: string, attachmentId: string): { bytes: Uint8Array; mediaType: string };
  load(taskId: string, attachments?: readonly Attachment[]): InputAttachment[] | undefined;
}

export interface TaskImageReader {
  read(worktreePath: string | undefined, requestedPath: string | string[]): Promise<{ bytes: Uint8Array; mediaType: string }>;
}
