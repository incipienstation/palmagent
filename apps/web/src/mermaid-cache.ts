import { onCacheSessionReset } from "./query-lifecycle";

type Theme = "light" | "dark";
type Renderer = (source: string, theme: Theme, cancelled: () => boolean) => Promise<string | null>;
type Job = { consumers: Set<AbortSignal>; abort: (event: Event) => void; promise: Promise<string | null> };
export const MERMAID_CACHE_LIMITS = { entries: 32, bytes: 2_000_000 };

// Each instance owns one fixed rendering/security policy. Only source and theme
// vary within that policy. Keep results in memory, never in browser storage.
export function createMermaidCache(renderer: Renderer) {
  const cache = new Map<string, string>();
  const pending = new Map<string, Job>();
  let bytes = 0;
  let generation = 0;
  // Mermaid configuration is global: keep configuration + rendering serialized,
  // even across clear(), while an old renderer is still finishing.
  let queue = Promise.resolve();
  const keyFor = (source: string, theme: Theme) => JSON.stringify([theme, source]);
  const subscribe = (job: Job, signal: AbortSignal) => {
    job.consumers.add(signal);
    signal.addEventListener("abort", job.abort, { once: true });
  };
  const size = (key: string, value: string) => 2 * (key.length + value.length);
  const get = (source: string, theme: Theme) => {
    const key = keyFor(source, theme);
    const value = cache.get(key);
    if (value !== undefined) { cache.delete(key); cache.set(key, value); }
    return value;
  };
  const remember = (key: string, value: string) => {
    const weight = size(key, value);
    if (weight > MERMAID_CACHE_LIMITS.bytes) return;
    cache.set(key, value); bytes += weight;
    while (cache.size > MERMAID_CACHE_LIMITS.entries || bytes > MERMAID_CACHE_LIMITS.bytes) {
      const [oldKey, oldValue] = cache.entries().next().value!;
      cache.delete(oldKey); bytes -= size(oldKey, oldValue);
    }
  };
  return {
    get,
    render(source: string, theme: Theme, signal: AbortSignal): Promise<string | null> {
      if (signal.aborted) return Promise.resolve(null);
      const cached = get(source, theme);
      if (cached !== undefined) return Promise.resolve(cached);
      const key = keyFor(source, theme);
      const existing = pending.get(key);
      if (existing) { subscribe(existing, signal); return existing.promise; }
      const epoch = generation;
      const consumers = new Set<AbortSignal>();
      const cancelled = () => epoch !== generation || consumers.size === 0;
      const job: Job = { consumers, abort: event => { consumers.delete(event.target as AbortSignal); }, promise: Promise.resolve(null) };
      subscribe(job, signal);
      job.promise = queue.then(async () => {
        try {
          if (cancelled()) return null;
          const result = await renderer(source, theme, cancelled);
          if (cancelled()) return null;
          // Incomplete streaming syntax and transient failures must remain retryable.
          if (result !== null) remember(key, result);
          return result;
        } catch { return null; }
        finally {
          for (const consumer of consumers) consumer.removeEventListener("abort", job.abort);
          consumers.clear();
          if (pending.get(key) === job) pending.delete(key);
        }
      });
      pending.set(key, job);
      queue = job.promise.then(() => {});
      return job.promise;
    },
    clear() { generation++; cache.clear(); pending.clear(); bytes = 0; },
  };
}

let nextId = 0;
async function renderSvg(source: string, theme: Theme, cancelled: () => boolean): Promise<string | null> {
  const { default: mermaid } = await import("mermaid");
  if (cancelled()) return null;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: theme === "dark" ? "dark" : "default",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    // Keep author directives from enabling HTML or replacing app policy.
    secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges",
      "suppressErrorRendering", "htmlLabels", "flowchart", "theme", "themeCSS"],
  });
  const container = document.createElement("div");
  container.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none";
  container.setAttribute("aria-hidden", "true");
  document.body.append(container);
  try {
    const { svg } = await mermaid.render(`mermaid-${++nextId}`, source, container);
    const documentSvg = new DOMParser().parseFromString(svg, "image/svg+xml");
    const root = documentSvg.documentElement;
    const viewBox = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
    if (viewBox?.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) {
      root.setAttribute("width", String(viewBox[2]));
      root.setAttribute("height", String(viewBox[3]));
    }
    // SVG images isolate diagram styles and disable embedded scripts/links.
    // Text labels (htmlLabels:false) also work in this image context.
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
  } finally { container.remove(); }
}

export const mermaidCache = createMermaidCache(renderSvg);
onCacheSessionReset(() => mermaidCache.clear());
