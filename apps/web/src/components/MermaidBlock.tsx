import { lazy, Suspense, useEffect, useState } from "react";
import { useTheme } from "../ThemeProvider";

const MermaidViewport = lazy(() => import("./MermaidViewport"));

// Mermaid has global configuration. Serialize configuration + rendering together
// so concurrently mounted diagrams cannot borrow another render's theme.
let renderQueue = Promise.resolve();
let nextId = 0;

type Result = { source: string; theme: string; url: string | null };

export function MermaidBlock({ source }: { source: string }) {
  const { resolved } = useTheme();
  const [result, setResult] = useState<Result>();
  const current = result?.source === source && result.theme === resolved ? result : undefined;

  useEffect(() => {
    let cancelled = false;
    // Streaming fences are frequently incomplete. Coalesce rapid text changes
    // and cancel queued work before parsing instead of accumulating stale renders.
    const timer = setTimeout(() => {
      renderQueue = renderQueue.then(async () => {
        if (cancelled) return;
        let container: HTMLDivElement | undefined;
        try {
          const { default: mermaid } = await import("mermaid");
          if (cancelled) return;
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            suppressErrorRendering: true,
            theme: resolved === "dark" ? "dark" : "default",
            htmlLabels: false,
            flowchart: { htmlLabels: false },
            // Keep author directives from enabling HTML or replacing app policy.
            secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges",
              "suppressErrorRendering", "htmlLabels", "flowchart", "theme", "themeCSS"],
          });
          container = document.createElement("div");
          container.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none";
          container.setAttribute("aria-hidden", "true");
          document.body.append(container);
          const { svg } = await mermaid.render(`mermaid-${++nextId}`, source, container);
          if (cancelled) return;
          const documentSvg = new DOMParser().parseFromString(svg, "image/svg+xml");
          const root = documentSvg.documentElement;
          const viewBox = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
          if (viewBox?.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) {
            root.setAttribute("width", String(viewBox[2]));
            root.setAttribute("height", String(viewBox[3]));
          }
          // SVG images isolate diagram styles and disable embedded scripts/links.
          // Text labels (htmlLabels:false) also work in this image context.
          const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
          setResult({ source, theme: resolved, url });
        } catch {
          if (!cancelled) setResult({ source, theme: resolved, url: null });
        } finally {
          container?.remove();
        }
      });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [source, resolved]);

  const code = <pre className="overflow-x-auto p-3 font-mono text-[12.5px] leading-[18px] text-strong"><code>{source}</code></pre>;
  return <div className="my-2 min-w-0 overflow-hidden rounded-md border border-border bg-muted">
    {current?.url ? <>
      <Suspense fallback={<p className="p-3 text-xs text-muted-foreground" role="status">Loading diagram controls…</p>}>
        <MermaidViewport key={current.url} url={current.url} />
      </Suspense>
      <details className="border-t border-border">
        <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">Diagram source</summary>
        {code}
      </details>
    </> : <>
      <p className="px-3 pt-2 text-xs text-muted-foreground" role="status">
        {current ? "Diagram unavailable — showing source." : "Rendering diagram…"}
      </p>
      {code}
    </>}
  </div>;
}
