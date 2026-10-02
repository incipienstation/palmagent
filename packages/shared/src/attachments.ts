import { z } from "zod";
import { HOST_INGRESS_REQUIREMENTS } from "./ingress.js";

export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const VIDEO_MEDIA_TYPES = ["video/mp4", "video/webm", "video/quicktime"] as const;
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
  mediaType: z.enum([...IMAGE_MEDIA_TYPES, ...VIDEO_MEDIA_TYPES]),
  size: z.number().int().positive(),
  width: ImageDimensionSchema.optional(),
  height: ImageDimensionSchema.optional(),
});
const FrameReferenceSchema = AttachmentReferenceSchema.extend({ timestamp: z.number().finite().nonnegative() })
  .refine(({ mediaType }) => (IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType));
export const AttachmentSchema = AttachmentReferenceSchema.extend({
  video: z.object({ duration: z.number().finite().positive(), frames: z.array(FrameReferenceSchema).min(1).max(INPUT_VIDEO_POLICY.maxFrames) }).optional(),
}).refine(({ width, height }) => (width === undefined) === (height === undefined))
  .refine(({ mediaType, video }) => isVideoMediaType(mediaType) === !!video);
export type Attachment = z.infer<typeof AttachmentSchema>;
export const AttachmentParamsSchema = z.object({ id: z.string().min(1), attachmentId: z.string().uuid() });
export function attachmentUrl(taskId: string, attachmentId: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`;
}
