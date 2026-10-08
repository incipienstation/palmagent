import { defaultUrlTransform } from "react-markdown";

// Both Markdown parsers preserve the same image sources. Other links keep the
// default protocol restrictions, and raw HTML stays escaped.
export function imageSource(value: string): string {
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return "";
  // Sandbox links may name local artifacts. Keep absolute paths only; the task
  // image endpoint still checks existence and containment in the working directory.
  if (/^sandbox:/i.test(value)) return /^sandbox:\/(?!\/)/i.test(value) ? value.slice(8) : "";
  if (/^data:/i.test(value)) {
    return value.length <= 7_000_000 && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value) ? value : "";
  }
  if (/^https?:\/\//i.test(value) || value.startsWith("//")) {
    try {
      const url = new URL(value, "https://example.invalid");
      return !url.username && !url.password ? value : "";
    } catch { return ""; }
  }
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      return !url.host || url.host === "localhost" ? value : "";
    } catch { return ""; }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return "";
  return value;
}

export function markdownUrlTransform(value: string, key: string): string {
  return key === "src" ? imageSource(value) : defaultUrlTransform(value);
}

export function previewSource(value: string, taskId?: string): string {
  const safe = imageSource(value);
  if (!safe) return "";
  if (/^(?:https?:\/\/|\/\/|data:)/i.test(safe)) return safe;
  if (!taskId) return "";
  // Only this task's generated attachment endpoint bypasses local-file resolution.
  const attachmentPrefix = `/api/tasks/${encodeURIComponent(taskId)}/attachments/`;
  if (safe.startsWith(attachmentPrefix) && /^[0-9a-f-]{36}$/.test(safe.slice(attachmentPrefix.length))) return safe;
  try {
    const path = decodeURIComponent(/^file:/i.test(safe) ? new URL(safe).pathname : safe);
    return `/api/tasks/${encodeURIComponent(taskId)}/image?${new URLSearchParams({ path })}`;
  } catch { return ""; }
}

/** Probe only generated local attachments; never fetch a Markdown remote URL. */
export async function attachmentExpired(src: string, signal: AbortSignal): Promise<boolean> {
  if (!/^\/api\/tasks\/[^/]+\/attachments\/[0-9a-f-]{36}$/.test(src)) return false;
  const response = await fetch(src, { cache: "no-store", signal });
  await response.body?.cancel();
  return response.status === 410;
}
