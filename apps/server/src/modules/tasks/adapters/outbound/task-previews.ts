import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ApplicationError } from "../../../../kernel/errors.js";
import { MAX_IMAGE_BYTES, rasterMediaType } from "../../application/attachments/output-images.js";
import type { TaskPreviewReader } from "../../application/ports/outbound/attachments.js";

const inside = (root: string, path: string) => {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};

type NativeSession = Parameters<TaskPreviewReader["readImage"]>[2];
const MAX_VISUALIZATION_BYTES = 5 * 1024 * 1024;

export async function readTaskImage(cwd: string | undefined, path: string, nativeSession?: NativeSession) {
  const bytes = await readPreview(cwd, path, "image", nativeSession);
  const mediaType = rasterMediaType(bytes);
  if (!mediaType) throw new ApplicationError("unsupported_media_type", "Preview supports PNG, JPEG, GIF, and WebP images");
  return { bytes, mediaType };
}

export function readTaskVisualization(cwd: string | undefined, path: string) {
  return readPreview(cwd, path, "visualization");
}

async function readPreview(cwd: string | undefined, path: string, kind: "image" | "visualization", nativeSession?: NativeSession) {
  const limit = kind === "image" ? MAX_IMAGE_BYTES : MAX_VISUALIZATION_BYTES;
  const label = kind === "image" ? "Image" : "Visualization";
  const unavailable = () => new ApplicationError("not_found", `${label} unavailable in this task's directories`);
  if (!cwd) throw unavailable();
  try {
    let root = await realpath(cwd);
    const file = await realpath(resolve(root, path));
    if (!inside(root, file) && nativeSession?.agent === "codex"
      && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(nativeSession.sessionId)) {
      const home = await realpath(nativeSession.home);
      const generated = resolve(home, "generated_images", nativeSession.sessionId);
      // A redirected session directory must not grant access to another session or home files.
      if (await realpath(generated) !== generated) throw unavailable();
      root = generated;
    }
    if (!inside(root, file)) throw unavailable();
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw unavailable();
      if (stat.size > limit) throw new ApplicationError("payload_too_large", `${label} exceeds the 5 MB preview limit`);
      // Check the opened descriptor too on Linux, closing directory-swap races.
      const openedFile = process.platform === "linux" ? await realpath(`/proc/self/fd/${handle.fd}`) : file;
      if (!inside(root, openedFile)) throw unavailable();
      if (kind === "visualization" && !/\.html?$/i.test(openedFile)) {
        throw new ApplicationError("unsupported_media_type", "Visualization requires an HTML file");
      }
      const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > stat.size) throw new ApplicationError("conflict", `${label} changed while loading; retry the preview`);
      return buffer.subarray(0, length);
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw unavailable();
  }
}
