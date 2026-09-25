import { z } from "zod";

/** A durable image reference; never contains a filesystem path or image bytes. */
export const AttachmentSchema = z.object({
  id: z.string().uuid(),
  mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  size: z.number().int().positive(),
  width: z.number().int().min(1).max(100_000).optional(),
  height: z.number().int().min(1).max(100_000).optional(),
}).refine(({ width, height }) => (width === undefined) === (height === undefined));
export type Attachment = z.infer<typeof AttachmentSchema>;
export const AttachmentParamsSchema = z.object({ id: z.string().min(1), attachmentId: z.string().uuid() });
export function attachmentUrl(taskId: string, attachmentId: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`;
}
