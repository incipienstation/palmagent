import { createContext, useContext, useEffect, useState } from "react";
import { previewSource, attachmentExpired } from "../image-source";
import { Maximize } from "lucide-react";
import { ImageViewerContent } from "./ImageViewerContent";
import { Button } from "./ui/button";
import { Dialog, DialogTrigger } from "./ui/dialog";

export const ImageTaskContext = createContext<string | undefined>(undefined);
export const ImageLinkContext = createContext(false);

const dimensionCache = new Map<string, { width: number; height: number }>();
function rememberDimensions(src: string, width: number, height: number) {
  if (src.startsWith("data:") || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return;
  dimensionCache.delete(src);
  dimensionCache.set(src, { width, height });
  if (dimensionCache.size > 256) dimensionCache.delete(dimensionCache.keys().next().value!);
}

export function ImagePreview({ src = "", alt = "", title, width, height, onLoad }: {
  src?: string; alt?: string; title?: string; width?: number; height?: number; onLoad?: () => void;
}) {
  const taskId = useContext(ImageTaskContext);
  const linked = useContext(ImageLinkContext);
  const resolved = previewSource(src, taskId);
  const dimensions = width && height ? { width, height } : dimensionCache.get(resolved);
  return <Preview key={resolved} src={resolved} alt={alt} title={title} dimensions={dimensions} onLoad={onLoad} linked={linked} />;
}

function Preview({ src, alt, title, dimensions, onLoad, linked }: {
  src: string; alt: string; title?: string; dimensions?: { width: number; height: number }; onLoad?: () => void; linked: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    // Only probe our attachment endpoint after an image error. Never fetch remote
    // Markdown URLs here, and never cache an expiration response offline.
    if (!failed || !/^\/api\/tasks\/[^/]+\/attachments\/[0-9a-f-]{36}$/.test(src)) return;
    const controller = new AbortController();
    void attachmentExpired(src, controller.signal)
      .then(value => { if (!controller.signal.aborted) setExpired(value); })
      .catch(() => {});
    return () => controller.abort();
  }, [failed, src]);
  const [attempt, setAttempt] = useState(0);
  const label = alt || "Image";
  if (!src || failed) return <span className="my-2 inline-flex max-w-full flex-wrap items-center gap-2 text-sm text-muted-foreground">
    <span>{expired ? "Image expired" : "Image unavailable"}: {label}</span>
    {src && !expired && !linked && <Button type="button" variant="outline" size="sm" onClick={() => { setFailed(false); setAttempt(attempt + 1); }}>Retry image</Button>}
  </span>;
  const image = <img key={attempt} src={src} alt={label} title={title} width={dimensions?.width} height={dimensions?.height}
    loading="lazy" decoding="async" referrerPolicy="no-referrer"
    onLoad={(event) => {
      const img = event.currentTarget;
      rememberDimensions(src, img.naturalWidth, img.naturalHeight);
      onLoad?.();
    }} onError={() => { setFailed(true); onLoad?.(); }}
    className="max-h-96 max-w-full rounded-lg object-contain" />;
  // A linked Markdown image keeps its existing link without nesting buttons.
  if (linked) return image;
  return <Dialog>
    <DialogTrigger asChild>
      <Button type="button" variant="ghost" className="relative my-2 h-auto max-w-full cursor-zoom-in p-0" aria-label={`Enlarge image: ${label}`}>
        {image}
        <span aria-hidden="true" className="pointer-events-none absolute top-1 right-1 rounded-md bg-muted p-1.5"><Maximize /></span>
      </Button>
    </DialogTrigger>
    <ImageViewerContent src={src} label={label} kind="image" onError={() => setFailed(true)} />
  </Dialog>;
}
