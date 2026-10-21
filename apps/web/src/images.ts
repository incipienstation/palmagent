import { FILE_MEDIA_TYPE, FileMetadataSchema, INPUT_FILE_POLICY, IMAGE_MEDIA_TYPES, INPUT_IMAGE_POLICY, isVideoMediaType } from "@palmagent/shared";
// Client-side attachment preparation. The images wire field also carries videos and files.
// Big images are downscaled to Claude's optimal long edge and re-encoded as
// JPEG so a screenshot stays well under the proxy/body limits; small ones are
// passed through untouched.
import type { ImageAttachment, InputAttachment } from "@palmagent/shared";

// Native files stay outside JS strings throughout draft, retry and transport.
export type DraftAttachment = InputAttachment & { blob?: Blob };
export function attachmentBlob(image: InputAttachment): Blob | undefined {
  return (image as DraftAttachment).blob;
}
export function attachmentSize(image: InputAttachment): number {
  return attachmentBlob(image)?.size ?? Math.floor(image.data.length * 3 / 4) - (image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0);
}
export function sameAttachments(left: readonly InputAttachment[] = [], right: readonly InputAttachment[] = []): boolean {
  return left.length === right.length && left.every((image, index) => {
    const other = right[index];
    const { data, blob, ...metadata } = image as DraftAttachment;
    const { data: otherData, blob: otherBlob, ...otherMetadata } = other as DraftAttachment;
    return data === otherData && blob === otherBlob && JSON.stringify(metadata) === JSON.stringify(otherMetadata);
  });
}

const LONG_EDGE = 1568; // Claude's documented optimal max long edge
const PASSTHROUGH_BYTES = 350_000; // below this (and within LONG_EDGE) keep the original bytes
const JPEG_QUALITY = 0.8;
export const MAX_ATTACHMENTS = INPUT_IMAGE_POLICY.maxCount;

const ACCEPTED = new Set<string>(IMAGE_MEDIA_TYPES);

// Files from a paste event's clipboard (screenshots arrive as image/png files).
export function imageFilesFromClipboard(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  return Array.from(dt.items)
    .filter((it) => it.kind === "file")
    .map((it) => it.getAsFile())
    .filter((f): f is File => !!f);
}

export async function fileToAttachment(file: File | Blob): Promise<DraftAttachment> {
  const extension = file instanceof File ? file.name.split(".").pop()?.toLowerCase() : undefined;
  const inferred = !file.type || file.type === "application/octet-stream" ? ({ mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" } as Record<string, string>)[extension ?? ""] : undefined;
  if (isVideoMediaType(file.type) || inferred) return (await import("./videos")).videoToAttachment(inferred ? file.slice(0, file.size, inferred) : file);
  const type = file.type || "application/octet-stream";
  if (!type.startsWith("image/") || type === "image/svg+xml") {
    if (file.size > INPUT_FILE_POLICY.maxBytes) throw new Error(`Files must be ${INPUT_FILE_POLICY.maxBytes / 1024 / 1024} MiB or smaller.`);
    const metadata = FileMetadataSchema.safeParse({ name: file instanceof File ? file.name : "attachment" });
    if (!metadata.success) throw new Error("Use a shorter filename without slashes or control characters.");
    return { mediaType: FILE_MEDIA_TYPE, data: "", blob: file, file: metadata.data };
  }

  // GIFs lose animation on canvas; pass small ones through, downscale-to-still otherwise.
  const bitmap = await loadBitmap(file);
  const oversized = Math.max(bitmap.width, bitmap.height) > LONG_EDGE;
  if (!oversized && file.size <= PASSTHROUGH_BYTES && ACCEPTED.has(type)) {
    const width = bitmap.width, height = bitmap.height;
    bitmap.close?.();
    return { mediaType: type, data: await blobToBase64(file), width, height };
  }

  const scale = oversized ? LONG_EDGE / Math.max(bitmap.width, bitmap.height) : 1;
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.fillStyle = "#fff"; // JPEG has no alpha — flatten transparency onto white
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", JPEG_QUALITY));
  if (!blob) throw new Error("image encode failed");
  return { mediaType: "image/jpeg", data: await blobToBase64(blob), width: w, height: h };
}

// The service still validates an encoded envelope. Reserve that same budget
// even though native files use fewer bytes on the multipart wire.
export function attachmentsWireSize(images: InputAttachment[]): number {
  return images.reduce((n, i) => n + (attachmentBlob(i) ? Math.ceil(attachmentBlob(i)!.size / 3) * 4 : i.data.length) + (i.video?.frames.reduce((sum, frame) => sum + frame.image.data.length, 0) ?? 0), 0);
}

export function attachmentPreviewUrl(img: ImageAttachment): string {
  return `data:${img.mediaType};base64,${img.data}`;
}

interface CloseableBitmap {
  width: number;
  height: number;
  close?: () => void;
}

async function loadBitmap(file: Blob): Promise<CloseableBitmap & CanvasImageSource> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall through to <img> decode (e.g. odd types) */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return Object.assign(img, { width: img.naturalWidth, height: img.naturalHeight });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error ?? new Error("file read failed"));
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.readAsDataURL(blob);
  });
}
