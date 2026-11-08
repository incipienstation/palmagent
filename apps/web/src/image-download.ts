function imageFilename(src: string, type: string): string {
  const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/avif": "avif" } as Record<string, string>)[type] || "img";
  if (!src.startsWith("data:")) {
    const url = new URL(src, window.location.href);
    const path = url.pathname.endsWith("/image") ? url.searchParams.get("path") : decodeURIComponent(url.pathname);
    const name = path?.split(/[\\/]/).pop()?.replace(/[<>:"|?*\u0000-\u001f\u007f]/g, "_");
    if (name && /\.(?:png|jpe?g|gif|webp|svg|avif)$/i.test(name)) return name;
  }
  return `image.${extension}`;
}

export function isRemoteImage(src: string): boolean {
  return !src.startsWith("data:") && new URL(src, window.location.href).origin !== window.location.origin;
}

export async function downloadImage(src: string, signal: AbortSignal): Promise<void> {
  let blob: Blob;
  if (src.startsWith("data:")) {
    // Embedded images do not need a fetch (and connect-src deliberately excludes data:).
    const comma = src.indexOf(",");
    const bytes = Uint8Array.from(atob(src.slice(comma + 1)), char => char.charCodeAt(0));
    blob = new Blob([bytes], { type: src.slice(5, src.indexOf(";")) });
  } else {
    const response = await fetch(src, { signal, cache: "no-store", credentials: "same-origin", mode: "same-origin" });
    if (!response.ok) throw new Error("Image download failed");
    blob = await response.blob();
  }
  signal.throwIfAborted();
  if (!blob.size || !blob.type.startsWith("image/")) throw new Error("Image download failed");
  const filename = imageFilename(src, blob.type);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Give the browser time to consume the URL before releasing its backing bytes.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
