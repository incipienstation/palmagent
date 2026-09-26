import type { ImageAttachment } from "@palmagent/shared";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export function rasterMediaType(bytes: Buffer): ImageAttachment["mediaType"] | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
}

function imageDimensions(bytes: Buffer, mediaType: ImageAttachment["mediaType"]): Pick<ImageAttachment, "width" | "height"> {
  let width: number | undefined, height: number | undefined;
  if (mediaType === "image/png" && bytes.length >= 24) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (mediaType === "image/gif" && bytes.length >= 10) {
    width = bytes.readUInt16LE(6);
    height = bytes.readUInt16LE(8);
  } else if (mediaType === "image/webp" && bytes.length >= 25) {
    const chunk = bytes.subarray(12, 16).toString("ascii");
    if (chunk === "VP8X" && bytes.length >= 30) {
      width = 1 + bytes.readUIntLE(24, 3);
      height = 1 + bytes.readUIntLE(27, 3);
    } else if (chunk === "VP8L" && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (chunk === "VP8 " && bytes.length >= 30
      && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      width = bytes.readUInt16LE(26) & 0x3fff;
      height = bytes.readUInt16LE(28) & 0x3fff;
    }
  } else if (mediaType === "image/jpeg" && bytes.length >= 4) {
    const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      if (offset >= bytes.length) break;
      const marker = bytes[offset++];
      if (marker === 0x00) continue;
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (frameMarkers.has(marker) && length >= 7) {
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  }
  return width && height && width <= 100_000 && height <= 100_000 ? { width, height } : {};
}

export function rasterImage(mediaType: unknown, data: unknown): ImageAttachment | undefined {
  if (typeof mediaType !== "string" || typeof data !== "string" || data.length > MAX_IMAGE_BYTES * 4 / 3 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return;
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return;
  const valid = rasterMediaType(bytes) === mediaType;
  return valid ? { mediaType, data: bytes.toString("base64"), ...imageDimensions(bytes, mediaType as ImageAttachment["mediaType"]) } : undefined;
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
