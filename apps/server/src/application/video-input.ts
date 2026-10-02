import { INPUT_VIDEO_POLICY, INPUT_IMAGE_POLICY, isVideoMediaType, type InputAttachment } from "@palmagent/shared";
import { rasterImage } from "./output-images.js";

/** Check the container independently of the browser's filename and MIME claim. */
export function videoMediaType(bytes: Buffer): string | undefined {
  if (bytes.length >= 16 && bytes.toString("ascii", 4, 8) === "ftyp") {
    const size = bytes.readUInt32BE(0), brand = bytes.toString("ascii", 8, 12);
    if (size < 16 || size > bytes.length) return;
    if (brand === "qt  ") return "video/quicktime";
    if (/^(isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV|dash)$/.test(brand)) return "video/mp4";
  }
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    && bytes.subarray(4, 4096).includes(Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]))) return "video/webm";
}

export function videoAttachment(value: unknown): InputAttachment | undefined {
  const input = value as InputAttachment | undefined;
  if (!input || !isVideoMediaType(input.mediaType) || typeof input.data !== "string"
    || input.data.length > Math.ceil(INPUT_VIDEO_POLICY.maxBytes / 3) * 4
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) return;
  const bytes = Buffer.from(input.data, "base64"), video = input.video;
  if (!bytes.length || bytes.length > INPUT_VIDEO_POLICY.maxBytes || bytes.toString("base64") !== input.data
    || videoMediaType(bytes) !== input.mediaType || !video || !Number.isFinite(video.duration) || video.duration <= 0
    || !Array.isArray(video.frames) || !video.frames.length || video.frames.length > INPUT_VIDEO_POLICY.maxFrames) return;
  let previous = -1;
  const frames: NonNullable<InputAttachment["video"]>["frames"] = [];
  for (const frame of video.frames) {
    if (!Number.isFinite(frame.timestamp) || frame.timestamp < 0 || frame.timestamp > video.duration || frame.timestamp <= previous) return;
    const image = frame.image?.data?.length * 0.75 <= INPUT_IMAGE_POLICY.maxBytes ? rasterImage(frame.image?.mediaType, frame.image?.data) : undefined;
    if (!image) return;
    frames.push({ timestamp: frame.timestamp, image }); previous = frame.timestamp;
  }
  return { mediaType: input.mediaType, data: bytes.toString("base64"), video: { duration: video.duration, frames } };
}
