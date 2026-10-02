import { INPUT_IMAGE_POLICY, isVideoMediaType } from "@palmagent/shared";
import type { InputAttachment } from "@palmagent/shared";
import { rasterImage } from "./output-images.js";
import { ApplicationError } from "../errors.js";

import { videoAttachment } from "./video-input.js";

const MAX_BYTES = INPUT_IMAGE_POLICY.maxBytes;

/** Shared bounded input contract for every task and message entry point. */
export function sanitizeImages(raw: unknown): InputAttachment[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) throw new ApplicationError("bad_request", "images must be an array");
  if (!raw.length) return undefined;
  if (raw.length > INPUT_IMAGE_POLICY.maxCount) throw new ApplicationError("bad_request", `Too many attachments (max ${INPUT_IMAGE_POLICY.maxCount})`);
  if (Buffer.byteLength(JSON.stringify(raw)) > INPUT_IMAGE_POLICY.maxWireBytes - 100_000) throw new ApplicationError("bad_request", "Attachments exceed the upload limit");
  return raw.map((value, index) => {
    const mediaType = String(value?.mediaType ?? "");
    const data = String(value?.data ?? "").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
    if (isVideoMediaType(mediaType)) {
      const video = videoAttachment({ ...value, data });
      if (!video) throw new ApplicationError("bad_request", `Invalid video content, frames, type, or size at index ${index}`);
      return video;
    }
    const image = data.length * 0.75 <= MAX_BYTES ? rasterImage(mediaType, data) : undefined;
    if (!image) throw new ApplicationError("bad_request", `Invalid image content, type, or size at index ${index}`);
    return image;
  });
}
