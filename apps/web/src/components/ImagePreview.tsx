import { createContext, useContext, useEffect, useState } from "react";
import { previewSource } from "../image-source";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";

export const ImageTaskContext = createContext<string | undefined>(undefined);
export const ImageLinkContext = createContext(false);

export function ImagePreview({ src = "", alt = "", title, onLoad }: {
  src?: string; alt?: string; title?: string; onLoad?: () => void;
}) {
  const taskId = useContext(ImageTaskContext);
  const linked = useContext(ImageLinkContext);
  const resolved = previewSource(src, taskId);
  return <Preview key={resolved} src={resolved} alt={alt} title={title} onLoad={onLoad} linked={linked} />;
}

function Preview({ src, alt, title, onLoad, linked }: {
  src: string; alt: string; title?: string; onLoad?: () => void; linked: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    // Only probe our attachment endpoint after an image error. Never fetch remote
    // Markdown URLs here, and never cache an expiration response offline.
    if (!failed || !/^\/api\/tasks\/[^/]+\/attachments\/[0-9a-f-]{36}$/.test(src)) return;
    const controller = new AbortController();
    void fetch(src, { cache: "no-store", signal: controller.signal })
      .then(response => { setExpired(response.status === 410); return response.body?.cancel(); })
      .catch(() => {});
    return () => controller.abort();
  }, [failed, src]);
  const [attempt, setAttempt] = useState(0);
  const [actualSize, setActualSize] = useState(false);
  const label = alt || "Image";
  if (!src || failed) return <span className="my-2 inline-flex max-w-full flex-wrap items-center gap-2 text-sm text-muted-foreground">
    <span>{expired ? "Image expired" : "Image unavailable"}: {label}</span>
    {src && !expired && !linked && <Button type="button" variant="outline" size="sm" onClick={() => { setFailed(false); setAttempt(attempt + 1); }}>Retry image</Button>}
  </span>;
  const image = <img key={attempt} src={src} alt={label} title={title} loading="lazy" decoding="async" referrerPolicy="no-referrer"
    onLoad={onLoad} onError={() => { setFailed(true); onLoad?.(); }}
    className="max-h-96 max-w-full rounded-lg object-contain" />;
  // A linked Markdown image keeps its existing link without nesting buttons.
  if (linked) return image;
  return <Dialog>
    <DialogTrigger asChild>
      <Button type="button" variant="ghost" className="my-2 h-auto max-w-full p-0" aria-label={`Enlarge image: ${label}`}>
        {image}
      </Button>
    </DialogTrigger>
    <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-5xl overflow-y-auto" aria-describedby={undefined}>
      <DialogHeader className="min-w-0 pr-8"><DialogTitle className="break-words [overflow-wrap:anywhere]">{label}</DialogTitle></DialogHeader>
      <div className="max-h-[70dvh] min-w-0 overflow-auto">
        <img src={src} alt={label} referrerPolicy="no-referrer" onError={() => setFailed(true)}
          className={cn("mx-auto", actualSize ? "max-w-none" : "max-h-[70dvh] max-w-full object-contain")} />
      </div>
      <Button type="button" variant="outline" aria-pressed={actualSize} onClick={() => setActualSize(!actualSize)}>
        {actualSize ? "Fit image" : "Actual size"}
      </Button>
    </DialogContent>
  </Dialog>;
}
