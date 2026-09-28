import { lazy, Suspense, useEffect, useState } from "react";
import { useTheme } from "../ThemeProvider";
import { mermaidCache } from "../mermaid-cache";

const MermaidViewport = lazy(() => import("./MermaidViewport"));

type Result = { source: string; theme: string; url: string | null };

export function MermaidBlock({ source }: { source: string }) {
  const { resolved } = useTheme();
  const [result, setResult] = useState<Result | undefined>(() => {
    const url = mermaidCache.get(source, resolved);
    return url === undefined ? undefined : { source, theme: resolved, url };
  });
  const cached = mermaidCache.get(source, resolved);
  const current = cached !== undefined ? { source, theme: resolved, url: cached }
    : result?.source === source && result.theme === resolved ? result : undefined;

  useEffect(() => {
    const url = mermaidCache.get(source, resolved);
    if (url !== undefined) {
      setResult({ source, theme: resolved, url });
      return;
    }
    const controller = new AbortController();
    // Streaming fences are frequently incomplete. Coalesce rapid text changes
    // and cancel queued work before parsing instead of accumulating stale renders.
    const timer = setTimeout(() => {
      void mermaidCache.render(source, resolved, controller.signal).then(url => {
        if (!controller.signal.aborted) setResult({ source, theme: resolved, url });
      });
    }, 200);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [source, resolved]);

  const code = <pre className="overflow-x-auto p-3 font-mono text-[12.5px] leading-[18px] text-strong"><code>{source}</code></pre>;
  // Keep the Markdown row at its final viewer height while Mermaid loads or
  // falls back to source. Otherwise replacing a long fence changes the virtual
  // row size during reverse scrolling.
  const blockHeight = "calc(clamp(10rem, 30dvh, 16rem) + 2.25rem)";
  return <div data-mermaid-block className="my-2 flex min-w-0 flex-col overflow-hidden rounded-md border border-border bg-muted"
    style={{ height: blockHeight }}>
    {current?.url ? <>
      <div className="min-h-0 flex-1">
        <Suspense fallback={<p className="p-3 text-xs text-muted-foreground" role="status">Loading diagram controls…</p>}>
          <MermaidViewport key={current.url} url={current.url} />
        </Suspense>
      </div>
      <details className="max-h-40 shrink-0 overflow-y-auto border-t border-border">
        <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">Diagram source</summary>
        {code}
      </details>
    </> : <>
      <p className="shrink-0 px-3 pt-2 text-xs text-muted-foreground" role="status">
        {current ? "Diagram unavailable — showing source." : "Rendering diagram…"}
      </p>
      <div className="min-h-0 flex-1 overflow-auto">{code}</div>
    </>}
  </div>;
}
