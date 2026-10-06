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
