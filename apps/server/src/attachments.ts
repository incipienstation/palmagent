import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, statfsSync, openSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Attachment, ImageAttachment } from "@palmagent/shared";
import type { Db } from "./db.js";
import { ATTACHMENT_DEFAULTS, ATTACHMENT_MAINTENANCE_MS, type AttachmentPolicy } from "./attachment-policy.js";
import { HttpError } from "./errors.js";
import { rasterImage, rasterMediaType } from "./output-images.js";
import { ensurePrivateDirectory, writePrivateFileAtomic } from "./private-files.js";

export interface AttachmentRecord extends Attachment { taskId: string; digest: string; unusedSince: number | null; expiredAt: number | null }
export interface AttachmentStorage {
  save(taskId: string, images?: readonly ImageAttachment[]): Attachment[] | undefined;
  read(taskId: string, id: string): { bytes: Buffer; mediaType: string };
  load(taskId: string, attachments?: readonly Attachment[]): ImageAttachment[] | undefined;
}
const MAX_BYTES = 4.5 * 1024 * 1024;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const reference = ({ id, mediaType, size }: AttachmentRecord): Attachment => ({ id, mediaType, size });

/** Immutable private files with a task-scoped SQLite index. Only the index grants access. */
export class LocalAttachmentStorage implements AttachmentStorage {
  private readonly directory: string;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly db: Db, private readonly policy: AttachmentPolicy = ATTACHMENT_DEFAULTS,
    private readonly now: () => number = Date.now) {
    this.directory = join(dirname(db.path), "attachments", basename(db.path));
  }
  save(taskId: string, images?: readonly ImageAttachment[]): Attachment[] | undefined {
    const normalized = sanitizeImages(images);
    if (!normalized) return undefined;
    const prepared = normalized.map(image => {
      const bytes = Buffer.from(image.data, "base64");
      return { bytes, mediaType: image.mediaType as Attachment["mediaType"], digest: digest(bytes) };
    });
    ensurePrivateDirectory(this.directory);
    const created: string[] = [];
    try {
      return this.db.transaction(() => {
        // Charge actual directory bytes, including orphan files and failed deletions.
        // A single transaction serializes admission across processes using this DB.
        return prepared.map(image => {
          const existing = this.db.attachmentByDigest(taskId, image.digest);
          if (existing && existing.expiredAt === null) {
            try {
              this.read(taskId, existing.id);
              this.db.setAttachmentLifecycle(existing.id, null, null);
              return reference(existing);
            } catch (error) { if (!(error instanceof HttpError)) throw error; }
          }
          this.assertCapacity(image.bytes.length);
          const record: AttachmentRecord = existing ?? { id: randomUUID(), taskId, mediaType: image.mediaType,
            size: image.bytes.length, digest: image.digest, unusedSince: null, expiredAt: null };
          const path = join(this.directory, record.id);
          if (!existing) created.push(path);
          writePrivateFileAtomic(path, image.bytes);
          if (existing) this.db.setAttachmentLifecycle(existing.id, null, null);
          else this.db.insertAttachment(record);
          return reference(record);
        });
      });
    } catch (error) {
      for (const path of created) this.remove(path);
      if (["ENOSPC", "EDQUOT"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw new HttpError(507, "Not enough disk space for attachments. Free disk space, then retry.");
      }
      throw error;
    }
  }
  read(taskId: string, id: string) {
    const record = this.db.attachment(taskId, id);
    if (!record) throw new HttpError(404, "Attachment not found");
    if (record.expiredAt !== null) throw new HttpError(410, "Attachment expired under the archived conversation retention policy");
    let fd: number | undefined;
    try {
      fd = openSync(join(this.directory, record.id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size !== record.size || stat.size > MAX_BYTES) throw new Error("Invalid stored attachment");
      const bytes = readFileSync(fd);
      if (digest(bytes) !== record.digest || rasterMediaType(bytes) !== record.mediaType) throw new Error("Invalid stored attachment");
      return { bytes, mediaType: record.mediaType };
    } catch {
      throw new HttpError(404, "Attachment unavailable");
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  load(taskId: string, attachments?: readonly Attachment[]): ImageAttachment[] | undefined {
    return attachments?.map(attachment => {
      const { bytes, mediaType } = this.read(taskId, attachment.id);
      return { mediaType, data: bytes.toString("base64") };
    });
  }
  start(): void {
    this.close();
    this.prune();
    this.timer = setInterval(() => {
      if (!this.db.isOpen) { this.close(); return; }
      this.prune();
    }, ATTACHMENT_MAINTENANCE_MS);
    this.timer.unref();
  }
  close(): void { clearInterval(this.timer); this.timer = undefined; }

  /** Mark first, then unlink: interrupted cleanup must never resurrect expired access. */
  prune(): void {
    try {
      this.db.transaction(() => {
        const now = this.now();
        const refs = new Map<string, ReturnType<Db["attachmentReferences"]>>();
        for (const record of this.db.attachmentInventory()) {
          if (record.expiredAt !== null) continue;
          let taskRefs = refs.get(record.taskId);
          if (!taskRefs) { taskRefs = this.db.attachmentReferences(record.taskId); refs.set(record.taskId, taskRefs); }
          if (taskRefs.pending.has(record.id)) {
            this.db.setAttachmentLifecycle(record.id, null, null);
          } else if (taskRefs.history.has(record.id)) {
            const expired = this.policy.retentionMs > 0 && record.status === "archived"
              && now - record.updatedAt >= this.policy.retentionMs;
            this.db.setAttachmentLifecycle(record.id, null, expired ? now : null);
          } else if (record.unusedSince === null) {
            this.db.setAttachmentLifecycle(record.id, now, null);
          } else if (now - record.unusedSince >= this.policy.unusedGraceMs) {
            this.db.deleteAttachment(record.id);
          }
        }
      });
      if (!existsSync(this.directory)) return;
      // Re-read under the writer lock: an explicit upload may have restored a file
      // after the marking transaction. Never unlink that newly accepted content.
      this.db.transaction(() => {
        const retained = new Set(this.db.attachmentInventory().filter(r => r.expiredAt === null).map(r => r.id));
        for (const name of readdirSync(this.directory)) {
          if (/^[0-9a-f-]{36}(?:\.[0-9a-f-]{36}\.tmp)?$/.test(name) && !retained.has(name)) this.remove(join(this.directory, name));
        }
      });
    } catch {
      console.warn("[attachments] Cleanup deferred; check database and storage permissions");
    }
  }
  private assertCapacity(bytes: number): void {
    // Recheck each physical write, accounting for completed repairs and filesystem
    // activity since the preceding file. Atomic replacement needs a temporary copy.
    if (this.usedBytes() + bytes > this.policy.maxBytes) {
      throw new HttpError(507, "Attachment storage is full. Free space or increase ATTACHMENT_MAX_BYTES, then retry.");
    }
    if (this.freeBytes() - bytes < this.policy.minFreeBytes) {
      throw new HttpError(507, "Not enough disk space for attachments. Free disk space, then retry.");
    }
  }
  private usedBytes(): number {
    return readdirSync(this.directory).reduce((total, name) => total + lstatSync(join(this.directory, name)).size, 0);
  }
  private freeBytes(): number {
    try {
      const { bavail, bsize } = statfsSync(this.directory);
      return bavail * bsize;
    } catch { throw new HttpError(507, "Cannot check attachment disk space. Check storage access, then retry."); }
  }
  private remove(path: string): void {
    try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

/** The same bounded input contract applies to every task and message entry point. */
export function sanitizeImages(raw: unknown): ImageAttachment[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) throw new HttpError(400, "images must be an array");
  if (!raw.length) return undefined;
  if (raw.length > 8) throw new HttpError(400, "Too many images (max 8)");
  return raw.map((value, index) => {
    const mediaType = String(value?.mediaType ?? "");
    const data = String(value?.data ?? "").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
    const image = data.length * 0.75 <= MAX_BYTES ? rasterImage(mediaType, data) : undefined;
    if (!image) throw new HttpError(400, `Invalid image content, type, or size at index ${index}`);
    return image;
  });
}
