import type { AgentKind, DeliverSessionImage, InputAttachment } from "@palmagent/shared";
import type { Attachment } from "@palmagent/shared";
import type { AttachmentRecord } from "../../../domain/models.js";

export interface AttachmentIndex {
  readonly path: string;
  readonly isOpen: boolean;
  transaction<T>(work: () => T): T;
  attachment(taskId: string, id: string): AttachmentRecord | undefined;
  attachmentByDigest(taskId: string, digest: string): AttachmentRecord | undefined;
  registerDeliveredImage(taskId: string, path: string, id: string): void;
  deliveredImageId(taskId: string, path: string): string | undefined;
  insertAttachment(record: AttachmentRecord): void;
  attachmentInventory(): (AttachmentRecord & { status: string; updatedAt: number })[];
  attachmentReferences(taskId: string): { history: Set<string>; pending: Set<string> };
  deleteAttachment(id: string): void;
  setAttachmentLifecycle(id: string, unusedSince: number | null, expiredAt: number | null): void;
}

export interface AttachmentContentStorage {
  save(taskId: string, images?: readonly InputAttachment[]): Attachment[] | undefined;
  read(taskId: string, id: string): { bytes: Uint8Array; mediaType: string };
  load(taskId: string, attachments?: readonly Attachment[]): InputAttachment[] | undefined;
}

export interface AttachmentStorage extends AttachmentContentStorage {
  deliverImage(taskId: string, path: string, image: DeliverSessionImage["image"]): Attachment;
  deliveredImageId(taskId: string, path: string): string | undefined;
  start(): void;
  close(): void;
  prune(): void;
}

export type AttachmentRetentionRepository = Pick<AttachmentIndex,
  "transaction" | "attachmentInventory" | "attachmentReferences" | "setAttachmentLifecycle" | "deleteAttachment">;
export interface AttachmentFileCollection {
  exists(): boolean;
  /** Called under the index writer lock, using references re-read in that transaction. */
  removeUnreferenced(retained: ReadonlySet<string>): void;
}

export interface TaskAttachmentReader {
  read(taskId: string, attachmentId: string): { bytes: Uint8Array; mediaType: string };
  load(taskId: string, attachments?: readonly Attachment[]): InputAttachment[] | undefined;
}

export interface TaskPreviewReader {
  readVisualization(worktreePath: string | undefined, requestedPath: string): Promise<Uint8Array>;
  readImage(worktreePath: string | undefined, requestedPath: string, nativeSession?: {
    agent: AgentKind; home: string; sessionId: string;
  }): Promise<{ bytes: Uint8Array; mediaType: string }>;
}
