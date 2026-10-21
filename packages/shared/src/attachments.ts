import { z } from "zod";
import { HOST_INGRESS_REQUIREMENTS } from "./ingress.js";

export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const VIDEO_MEDIA_TYPES = ["video/mp4", "video/webm", "video/quicktime"] as const;
export const FILE_MEDIA_TYPE = "application/octet-stream" as const;
export const INPUT_FILE_POLICY = { maxBytes: 256 * 1024 * 1024 } as const;
export const FileMetadataSchema = z.object({ name: z.string().min(1).max(255)
  .regex(/^[^/\\\x00-\x1f\x7f]+$/).refine(name => name !== "." && name !== "..")
  .refine(name => {
    try { return encodeURIComponent(name).replace(/%[0-9A-F]{2}/g, "x").length <= 255; }
    catch { return false; }
  }) });
export const INPUT_VIDEO_POLICY = { maxBytes: 20 * 1024 * 1024, maxFrames: 8 } as const;
export const isVideoMediaType = (type: string): boolean => (VIDEO_MEDIA_TYPES as readonly string[]).includes(type);
export const INPUT_IMAGE_POLICY = {
  maxCount: 8, maxBytes: 4.5 * 1024 * 1024, maxDimension: 100_000,
  maxWireBytes: HOST_INGRESS_REQUIREMENTS.maxBodyBytes,
} as const;
export const ImageDimensionSchema = z.number().int().min(1).max(INPUT_IMAGE_POLICY.maxDimension);

/** A durable media reference; never contains a filesystem path or image bytes. */
const AttachmentReferenceSchema = z.object({
  id: z.string().uuid(),
  mediaType: z.enum([...IMAGE_MEDIA_TYPES, ...VIDEO_MEDIA_TYPES, FILE_MEDIA_TYPE]),
  size: z.number().int().nonnegative(),
  width: ImageDimensionSchema.optional(),
  height: ImageDimensionSchema.optional(),
});
const FrameReferenceSchema = AttachmentReferenceSchema.extend({ timestamp: z.number().finite().nonnegative() })
  .refine(({ mediaType }) => (IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType));
export const AttachmentSchema = AttachmentReferenceSchema.extend({
  file: FileMetadataSchema.optional(),
  video: z.object({ duration: z.number().finite().positive(), frames: z.array(FrameReferenceSchema).min(1).max(INPUT_VIDEO_POLICY.maxFrames) }).optional(),
}).refine(({ width, height }) => (width === undefined) === (height === undefined))
  .refine(({ mediaType, video }) => isVideoMediaType(mediaType) === !!video)
  .refine(({ mediaType, file, width, height, video }) => (mediaType === FILE_MEDIA_TYPE) === !!file && (!file || (!video && width === undefined && height === undefined)));
export type Attachment = z.infer<typeof AttachmentSchema>;
export const AttachmentParamsSchema = z.object({ id: z.string().min(1), attachmentId: z.string().uuid() });
export function attachmentUrl(taskId: string, attachmentId: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`;
}
