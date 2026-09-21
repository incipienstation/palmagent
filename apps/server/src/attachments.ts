import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Attachment, ImageAttachment } from "@palmagent/shared";
import type { Db } from "./db.js";
import { HttpError } from "./errors.js";
import { rasterImage, rasterMediaType } from "./output-images.js";
import { ensurePrivateDirectory, writePrivateFileAtomic } from "./private-files.js";

export interface AttachmentRecord extends Attachment { taskId: string; digest: string }
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
  constructor(private readonly db: Db) {
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
      return this.db.transaction(() => prepared.map(image => {
        const existing = this.db.attachmentByDigest(taskId, image.digest);
        if (existing) {
          // Repair missing or damaged bytes on explicit resubmission.
          try { this.read(taskId, existing.id); }
          catch { writePrivateFileAtomic(join(this.directory, existing.id), image.bytes); }
          return reference(existing);
        }
        const record: AttachmentRecord = { id: randomUUID(), taskId, mediaType: image.mediaType, size: image.bytes.length, digest: image.digest };
        const path = join(this.directory, record.id);
        created.push(path);
        writePrivateFileAtomic(path, image.bytes);
        this.db.insertAttachment(record);
        return reference(record);
      }));
    } catch (error) {
      for (const path of created) this.remove(path);
      throw error;
    }
  }
  read(taskId: string, id: string) {
    const record = this.db.attachment(taskId, id);
    if (!record) throw new HttpError(404, "Attachment not found");
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
  /** Run at startup and after permanent repository deletion, never on archive. */
  prune(): void {
    if (!existsSync(this.directory)) return;
    try {
      // Serialize with writers before taking the index snapshot: another server
      // opening this database must not collect a file whose write is in flight.
      this.db.transaction(() => {
        const retained = this.db.attachmentIds();
        for (const name of readdirSync(this.directory)) {
          if (/^[0-9a-f-]{36}(?:\.[0-9a-f-]{36}\.tmp)?$/.test(name) && !retained.has(name)) this.remove(join(this.directory, name));
        }
      });
    } catch {
      // Metadata already denies access; retry file cleanup on the next startup.
      console.warn("[attachments] File cleanup deferred; check storage permissions");
    }
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
