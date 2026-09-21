import { memo, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "./ui/button";

// Code-frame pattern: https://www.rareui.com/components/codeblock
// Keep the frame stable while the optional syntax renderer loads or streams.
export const CodeBlock = memo(function CodeBlock({ source, language, filename }: {
  source: string; language?: string; filename?: string;
}) {
  const [Renderer, setRenderer] = useState<typeof import("./CodeHighlight").default>();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mounted = useRef(true);
  const highlight = !!language && source.length <= 20_000;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimeout(reset.current); };
  }, []);
  useEffect(() => {
    if (!highlight) return;
    let active = true;
    void import("./CodeHighlight").then(module => {
      if (active) setRenderer(() => module.default);
    }).catch(() => { /* Plain code remains readable when the chunk is unavailable. */ });
    return () => { active = false; };
  }, [highlight]);
  useEffect(() => { setCopied(false); setCopyError(false); clearTimeout(reset.current); }, [source]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(source);
      if (!mounted.current) return;
      setCopied(true); setCopyError(false);
      clearTimeout(reset.current);
      reset.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      if (mounted.current) { setCopied(false); setCopyError(true); }
    }
  }
  return <figure data-code-block className="my-3 min-w-0 overflow-hidden rounded-xl border border-border bg-muted">
    <figcaption className="flex min-h-11 items-center gap-2 border-b border-border px-3 font-sans text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate font-mono" title={filename}>{filename || language || "Code"}</span>
      {filename && language && <span>{language}</span>}
      <Button type="button" variant="ghost" size="icon-lg" aria-label={copied ? "Code copied" : "Copy code"} onClick={() => void copy()}>
        {copied ? <Check /> : <Copy />}
      </Button>
      <span role="status" className="sr-only">{copied ? "Copied to clipboard" : ""}</span>
    </figcaption>
    <pre className="m-0 overflow-x-auto p-3 font-mono text-[12.5px] leading-[20px] text-strong [overflow-wrap:normal]">
      <code>{highlight && Renderer ? <Renderer source={source} language={language!} /> : source}</code>
    </pre>
    {copyError && <p role="status" className="px-3 pb-3 font-sans text-xs text-muted-foreground">Couldn’t copy. Select the code to copy it manually.</p>}
  </figure>;
});
