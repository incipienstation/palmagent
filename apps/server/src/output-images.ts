import type { ImageAttachment } from "@palmagent/shared";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export function rasterImage(mediaType: unknown, data: unknown): ImageAttachment | undefined {
  if (typeof mediaType !== "string" || typeof data !== "string" || data.length > MAX_IMAGE_BYTES * 4 / 3 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return;
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return;
  const valid = mediaType === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : mediaType === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : mediaType === "image/gif" ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))
    : mediaType === "image/webp" ? bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP" : false;
  return valid ? { mediaType, data: bytes.toString("base64") } : undefined;
}

// Only recognized structured content blocks. Never read a path from model output.
// Remove image bodies from verbose text while emitting a bounded gallery.
export function extractOutputImages(payload: unknown): { payload: unknown; images: ImageAttachment[] } {
  const images: ImageAttachment[] = [];
  let visited = 0;
  function visit(value: unknown, depth: number): unknown {
    if (++visited > 20_000 || depth > 20) return "[output truncated]";
    if (Array.isArray(value)) return value.map((v) => visit(v, depth + 1));
    if (!value || typeof value !== "object") return value;
    const block = value as Record<string, unknown>;
    if (block.type === "image") {
      const source = block.source as Record<string, unknown> | undefined;
      const img = rasterImage(source?.type === "base64" ? source.media_type : block.mimeType, source?.type === "base64" ? source.data : block.data);
      if (img && images.length < 4) images.push(img);
      return { type: "image", text: img ? "Image output" : "Unsupported image output" };
    }
    return Object.fromEntries(Object.entries(block).map(([key, value]) => [key, visit(value, depth + 1)]));
  }
  return { payload: visit(payload, 0), images };
}
