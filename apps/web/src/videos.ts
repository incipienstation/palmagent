import { INPUT_VIDEO_POLICY, isVideoMediaType, type InputAttachment } from "@palmagent/shared";
import { fileToAttachment, blobToBase64 } from "./images";

function waitFor(video: HTMLVideoElement, event: "loadeddata" | "seeked"): Promise<void> {
  return new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timer); video.removeEventListener(event, done); video.removeEventListener("error", failed); };
    const done = () => { clean(); resolve(); };
    const failed = () => { clean(); reject(new Error("This video cannot be decoded. Try MP4 (H.264) or WebM.")); };
    const timer = setTimeout(failed, 15_000);
    video.addEventListener(event, done, { once: true });
    video.addEventListener("error", failed, { once: true });
  });
}

/** Preserve the original while preparing bounded, timestamped visual input locally. */
export async function videoToAttachment(file: File | Blob): Promise<InputAttachment> {
  if (!isVideoMediaType(file.type)) throw new Error("Supported video formats: MP4, WebM, and MOV.");
  if (file.size > INPUT_VIDEO_POLICY.maxBytes) throw new Error("Videos must be 20 MiB or smaller. Trim or compress this video, then retry.");
  const video = document.createElement("video"), url = URL.createObjectURL(file);
  video.muted = true; video.playsInline = true; video.preload = "auto";
  try {
    const loaded = waitFor(video, "loadeddata"); video.src = url; await loaded;
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0 || !video.videoWidth || !video.videoHeight) throw new Error("This file does not contain a playable video.");
    const canvas = document.createElement("canvas"), scale = Math.min(1, 1568 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Video frame preparation is unavailable in this browser.");
    const count = Math.min(INPUT_VIDEO_POLICY.maxFrames, Math.max(1, Math.ceil(duration / 2)));
    const frames: NonNullable<InputAttachment["video"]>["frames"] = [];
    for (let index = 0; index < count; index++) {
      const timestamp = count === 1 ? 0 : index * Math.max(0, duration - Math.min(0.1, duration / 2)) / (count - 1);
      // Seek even at zero: loadeddata can precede the first drawable MOV frame.
      const seeked = waitFor(video, "seeked"); video.currentTime = timestamp; await seeked;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.8));
      if (!blob) throw new Error("Video frame preparation failed.");
      frames.push({ timestamp, image: await fileToAttachment(blob) });
    }
    return { mediaType: file.type, data: await blobToBase64(file), video: { duration, frames } };
  } finally {
    video.pause(); video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url);
  }
}
