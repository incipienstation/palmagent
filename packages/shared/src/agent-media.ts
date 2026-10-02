import type { ImageAttachment, InputAttachment } from "./requests.js";

/** Both agent protocols consume raster images. Keep the sampling limits explicit. */
export function sampledAgentInput(text: string, attachments: readonly InputAttachment[] = []): { text: string; images: ImageAttachment[] } {
  const images: ImageAttachment[] = [], notes: string[] = [];
  attachments.forEach((attachment, index) => {
    if (!attachment.video) { images.push(attachment); return; }
    const { duration, frames } = attachment.video;
    const first = images.length + 1;
    images.push(...frames.map(frame => frame.image));
    notes.push(`Video attachment ${index + 1} (${duration.toFixed(2)} seconds): images ${first}-${images.length} are sampled frames at ${frames.map(frame => `${frame.timestamp.toFixed(2)}s`).join(", ")}, in order. Only these frames are provided; audio and motion between frames are not included.`);
  });
  return { text: [text, ...notes].filter(Boolean).join("\n\n"), images };
}
