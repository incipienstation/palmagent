import { z } from "zod";
import { HOST_INGRESS_REQUIREMENTS } from "./ingress.js";

export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const INPUT_IMAGE_POLICY = {
  maxCount: 8, maxBytes: 4.5 * 1024 * 1024, maxDimension: 100_000,
  maxWireBytes: HOST_INGRESS_REQUIREMENTS.maxBodyBytes,
} as const;
export const ImageDimensionSchema = z.number().int().min(1).max(INPUT_IMAGE_POLICY.maxDimension);

/** A durable image reference; never contains a filesystem path or image bytes. */
export const AttachmentSchema = z.object({
  id: z.string().uuid(),
  mediaType: z.enum(IMAGE_MEDIA_TYPES),
  size: z.number().int().positive(),
  width: ImageDimensionSchema.optional(),
  height: ImageDimensionSchema.optional(),
}).refine(({ width, height }) => (width === undefined) === (height === undefined));
export type Attachment = z.infer<typeof AttachmentSchema>;
export const AttachmentParamsSchema = z.object({ id: z.string().min(1), attachmentId: z.string().uuid() });
export function attachmentUrl(taskId: string, attachmentId: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`;
}
