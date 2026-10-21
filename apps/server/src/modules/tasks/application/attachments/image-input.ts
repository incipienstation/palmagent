import { FILE_MEDIA_TYPE, FileMetadataSchema, INPUT_FILE_POLICY, INPUT_IMAGE_POLICY, isVideoMediaType } from "@palmagent/shared";
import type { InputAttachment } from "@palmagent/shared";
import { rasterImage } from "./output-images.js";
import { ApplicationError } from "../../../../kernel/errors.js";

import { base64ByteLength } from "./binary.js";
import { videoAttachment } from "./video-input.js";

const MAX_BYTES = INPUT_IMAGE_POLICY.maxBytes;

/** Shared bounded input contract for every task and message entry point. */
export function sanitizeImages(raw: unknown): InputAttachment[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) throw new ApplicationError("bad_request", "images must be an array");
  if (!raw.length) return undefined;
  if (raw.length > INPUT_IMAGE_POLICY.maxCount) throw new ApplicationError("bad_request", `Too many attachments (max ${INPUT_IMAGE_POLICY.maxCount})`);
  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > INPUT_IMAGE_POLICY.maxWireBytes - 100_000) throw new ApplicationError("bad_request", "Attachments exceed the upload limit");
  return raw.map((value, index) => {
    const mediaType = String(value?.mediaType ?? "");
    const data = String(value?.data ?? "").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
    if (value?.file !== undefined || mediaType === FILE_MEDIA_TYPE) {
      const file = FileMetadataSchema.safeParse(value?.file);
      const size = data.length <= Math.ceil(INPUT_FILE_POLICY.maxBytes / 3) * 4 ? base64ByteLength(data) : undefined;
      if (!file.success || mediaType !== FILE_MEDIA_TYPE || value.video || value.width !== undefined || value.height !== undefined
        || size === undefined || size > INPUT_FILE_POLICY.maxBytes) {
        throw new ApplicationError("bad_request", `Invalid file name, content, type, or size at index ${index}`);
      }
      return { mediaType, data, file: file.data };
    }
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
