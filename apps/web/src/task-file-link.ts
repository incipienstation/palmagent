// Preserve ordinary web URLs, app routes, query links and document fragments.
// Only explicit local paths or filenames get a task-file viewer.
export function taskFileLink(href: string) {
  let local = href;
  if (/^sandbox:\/(?!\/)/i.test(local)) local = local.slice(8);
  if (/^file:\/\//i.test(local)) {
    try {
      const url = new URL(local);
      if ((url.host && url.host !== "localhost") || url.search) return;
      local = url.pathname + url.hash;
    } catch { return; }
  }
  if (!local || /[?\\\u0000-\u001f\u007f]/.test(local) || /^(?:\/\/|\/api(?:\/|$)|\/assets\/)/.test(local)) return;
  const suffix = /(?::([1-9]\d*)(?::[1-9]\d*)?|#L([1-9]\d*))$/.exec(local);
  const rawPath = suffix ? local.slice(0, suffix.index) : local;
  if (!rawPath || rawPath.includes("#") || rawPath.endsWith("/") || /^[a-z][a-z\d+.\-]*:/i.test(rawPath)) return;
  // A URL scheme followed by a number can resemble a bare filename and line.
  if (suffix?.[1] && /^[a-z][a-z\d+-]*$/i.test(rawPath) && rawPath === rawPath.toLowerCase()) return;
  try {
    const path = decodeURIComponent(rawPath);
    if (/[\\\u0000-\u001f\u007f]/.test(path)) return;
    const line = suffix ? Number(suffix[1] ?? suffix[2]) : undefined;
    // Prefix unqualified names so even a filename with a line suffix cannot
    // become a browser URL scheme when rendered without task context.
    const href = local.startsWith("/") ? local : "./" + local;
    return { path, line, href };
  } catch { return; }
}
