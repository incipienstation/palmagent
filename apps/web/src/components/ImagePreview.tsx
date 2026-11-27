import { createContext, useContext, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { previewSource, attachmentExpired } from "../image-source";
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

type PreviewLayout = "inline" | "single" | "tile";

export function ImagePreview({ src = "", alt = "", title, width, height, onLoad, layout = "inline" }: {
  layout?: PreviewLayout; src?: string; alt?: string; title?: string; width?: number; height?: number; onLoad?: () => void;
}) {
  const taskId = useContext(ImageTaskContext);
  const linked = useContext(ImageLinkContext);
  const resolved = previewSource(src, taskId);
  const dimensions = width && height ? { width, height } : dimensionCache.get(resolved);
  return <Preview key={resolved} src={resolved} alt={alt} title={title} dimensions={dimensions} onLoad={onLoad} linked={linked} layout={layout} />;
}

function Preview({ src, alt, title, dimensions, onLoad, linked, layout }: {
  src: string; alt: string; title?: string; dimensions?: { width: number; height: number }; onLoad?: () => void; linked: boolean; layout: PreviewLayout;
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
  // Size the trigger before lazy loading, including the height limit for tall photos.
  const singleWidth = layout === "single" && dimensions
    ? `min(${dimensions.width}px, calc(24rem * ${dimensions.width / dimensions.height}))`
    : undefined;
  const image = <img key={attempt} src={src} alt={label} title={title} width={dimensions?.width} height={dimensions?.height}
    loading="lazy" decoding="async" referrerPolicy="no-referrer"
    onLoad={(event) => {
      const img = event.currentTarget;
      rememberDimensions(src, img.naturalWidth, img.naturalHeight);
      onLoad?.();
    }} onError={() => { setFailed(true); onLoad?.(); }}
    className={cn(layout === "inline" ? "rounded-lg" : "rounded-2xl",
      layout === "tile" ? "size-full object-cover" : "max-h-96 max-w-full object-contain",
      layout === "single" && ["h-auto", singleWidth ? "w-full" : "w-auto"],
    )} />;
  // A linked Markdown image keeps its existing link without nesting buttons.
  if (linked) return image;
  return <Dialog>
    <DialogTrigger asChild>
      <Button type="button" variant="ghost" className={cn("h-auto max-w-full cursor-zoom-in p-0",
        layout === "inline" ? "my-2" : "overflow-hidden rounded-2xl border-0",
        layout === "single" && "block w-fit",
        layout === "tile" && "aspect-square w-full",
      )} style={{ width: singleWidth }} aria-label={`Enlarge image: ${label}`}>
        {image}
      </Button>
    </DialogTrigger>
    <ImageViewerContent src={src} label={label} kind="image" onError={() => setFailed(true)} />
  </Dialog>;
}
