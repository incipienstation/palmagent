// Client-side image attachment prep: paste/file → ImageAttachment (base64).
// Big images are downscaled to Claude's optimal long edge and re-encoded as
// JPEG so a screenshot stays well under the proxy/body limits; small ones are
// passed through untouched.
import type { ImageAttachment } from "@palmagent/shared";

const LONG_EDGE = 1568; // Claude's documented optimal max long edge
const PASSTHROUGH_BYTES = 350_000; // below this (and within LONG_EDGE) keep the original bytes
const JPEG_QUALITY = 0.8;
export const MAX_ATTACHMENTS = 8;

const ACCEPTED = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

// Files from a paste event's clipboard (screenshots arrive as image/png files).
export function imageFilesFromClipboard(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  return Array.from(dt.items)
    .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
    .map((it) => it.getAsFile())
    .filter((f): f is File => !!f);
}

export async function fileToAttachment(file: File | Blob): Promise<ImageAttachment> {
  const type = file.type || "image/png";
  if (!type.startsWith("image/")) throw new Error(`not an image: ${type}`);

  // GIFs lose animation on canvas; pass small ones through, downscale-to-still otherwise.
  const bitmap = await loadBitmap(file);
  const oversized = Math.max(bitmap.width, bitmap.height) > LONG_EDGE;
  if (!oversized && file.size <= PASSTHROUGH_BYTES && ACCEPTED.has(type)) {
    bitmap.close?.();
    return { mediaType: type, data: await blobToBase64(file) };
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
  return { mediaType: "image/jpeg", data: await blobToBase64(blob) };
}

// Rough request-body cost of the attachments (base64 chars ≈ bytes on the wire).
export function attachmentsWireSize(images: ImageAttachment[]): number {
  return images.reduce((n, i) => n + i.data.length, 0);
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

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error ?? new Error("file read failed"));
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.readAsDataURL(blob);
  });
}
