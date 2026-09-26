import type { ImageAttachment } from "@palmagent/shared";
import { rasterImage } from "./output-images.js";
import { ApplicationError } from "../errors.js";

const MAX_BYTES = 4.5 * 1024 * 1024;

/** Shared bounded input contract for every task and message entry point. */
export function sanitizeImages(raw: unknown): ImageAttachment[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) throw new ApplicationError("bad_request", "images must be an array");
  if (!raw.length) return undefined;
  if (raw.length > 8) throw new ApplicationError("bad_request", "Too many images (max 8)");
  return raw.map((value, index) => {
    const mediaType = String(value?.mediaType ?? "");
    const data = String(value?.data ?? "").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
    const image = data.length * 0.75 <= MAX_BYTES ? rasterImage(mediaType, data) : undefined;
    if (!image) throw new ApplicationError("bad_request", `Invalid image content, type, or size at index ${index}`);
    return image;
  });
}
