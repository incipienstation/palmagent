import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { HttpError } from "./service.js";
import { MAX_IMAGE_BYTES, rasterMediaType } from "./output-images.js";

const inside = (root: string, path: string) => {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};

// Local previews are bounded raster files in this task's working directory.
// Resolve symlinks before checking containment; never proxy arbitrary URLs.
export async function readTaskImage(cwd: string | undefined, path: string) {
  const unavailable = () => new HttpError(404, "Image unavailable in this task's working directory");
  if (!cwd) throw unavailable();
  try {
    const root = await realpath(cwd);
    const file = await realpath(resolve(root, path));
    if (!inside(root, file)) throw unavailable();
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw unavailable();
      if (stat.size > MAX_IMAGE_BYTES) throw new HttpError(413, "Image exceeds the 5 MB preview limit");
      // Check the opened descriptor too on Linux, closing directory-swap races.
      if (process.platform === "linux" && !inside(root, await realpath(`/proc/self/fd/${handle.fd}`))) throw unavailable();
      const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_IMAGE_BYTES + 1));
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > stat.size) throw new HttpError(409, "Image changed while loading; retry the preview");
      const bytes = buffer.subarray(0, length);
      const mediaType = rasterMediaType(bytes);
      if (!mediaType) throw new HttpError(415, "Preview supports PNG, JPEG, GIF, and WebP images");
      return { bytes, mediaType };
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw unavailable();
  }
}
