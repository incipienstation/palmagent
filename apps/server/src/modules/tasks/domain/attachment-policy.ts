/** Installation-wide storage policy. Zero retention keeps archived images indefinitely. */
export interface AttachmentPolicy {
  maxBytes: number;
  minFreeBytes: number;
  unusedGraceMs: number;
  retentionMs: number;
}
export const ATTACHMENT_DEFAULTS: AttachmentPolicy = {
  maxBytes: 1024 ** 3,
  minFreeBytes: 256 * 1024 ** 2,
  unusedGraceMs: 24 * 60 * 60 * 1000,
  retentionMs: 0,
};
export const ATTACHMENT_MAINTENANCE_MS = 60 * 60 * 1000;

export interface AttachmentRetentionRecord {
  id: string;
  unusedSince: number | null;
  expiredAt: number | null;
  status: string;
  updatedAt: number;
}
export interface AttachmentReferences { history: Set<string>; pending: Set<string> }
export type AttachmentRetentionDecision = { kind: "delete" } |
  { kind: "update"; unusedSince: number | null; expiredAt: number | null } | undefined;

/** Expiration is durable; only an explicit upload can restore an expired attachment. */
export function attachmentRetention(record: AttachmentRetentionRecord, references: AttachmentReferences,
  policy: AttachmentPolicy, now: number): AttachmentRetentionDecision {
  if (record.expiredAt !== null) return;
  if (references.pending.has(record.id)) return { kind: "update", unusedSince: null, expiredAt: null };
  if (references.history.has(record.id)) {
    const expired = policy.retentionMs > 0 && record.status === "archived" && now - record.updatedAt >= policy.retentionMs;
    return { kind: "update", unusedSince: null, expiredAt: expired ? now : null };
  }
  if (record.unusedSince === null) return { kind: "update", unusedSince: now, expiredAt: null };
  if (now - record.unusedSince >= policy.unusedGraceMs) return { kind: "delete" };
}
