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

export function ImagePreview({ src: source = "", alt = "", title, width, height, onLoad, layout = "inline", localUpload = false }: {
  localUpload?: boolean; layout?: PreviewLayout; src?: string; alt?: string; title?: string; width?: number; height?: number; onLoad?: () => void;
}) {
  const taskId = useContext(ImageTaskContext);
  const linked = useContext(ImageLinkContext);
  const src = previewSource(source, taskId);
  const dimensions = width && height ? { width, height } : dimensionCache.get(src);
  // The browser can clear a decoded image immediately on a src change. Keep the
  // uploaded thumbnail mounted until its stored replacement is ready to paint.
  const [localSrc, setLocalSrc] = useState(() => localUpload ? src : undefined);
  const fallback = localSrc && localSrc !== src ? localSrc : undefined;
  const [error, setError] = useState<{ src: string; expired: boolean } | null>(null);
  const failed = error?.src === src;
  useEffect(() => {
    // Only probe our attachment endpoint after an image error. Never fetch remote
    // Markdown URLs here, and never cache an expiration response offline.
    if (!failed || !/^\/api\/tasks\/[^/]+\/attachments\/[0-9a-f-]{36}$/.test(src)) return;
    const controller = new AbortController();
    void attachmentExpired(src, controller.signal)
      .then(expired => { if (expired && !controller.signal.aborted) setError({ src, expired }); })
      .catch(() => {});
    return () => controller.abort();
  }, [failed, src]);
  const expired = failed && error.expired;
  const onError = () => { setLocalSrc(undefined); setError({ src, expired: false }); };
  const label = alt || "Image";
  if (!src || failed) return <span className="my-2 inline-flex max-w-full flex-wrap items-center gap-2 text-sm text-muted-foreground">
    <span>{expired ? "Image expired" : "Image unavailable"}: {label}</span>
    {src && !expired && !linked && <Button type="button" variant="outline" size="sm" onClick={() => setError(null)}>Retry image</Button>}
  </span>;
  // Size the trigger before lazy loading, including the height limit for tall photos.
  const singleWidth = layout === "single" && dimensions
    ? `min(${dimensions.width}px, calc(24rem * ${dimensions.width / dimensions.height}))`
    : undefined;
  const thumbnail = (url: string, preloading = false) => <img key={url} src={url} hidden={preloading} alt={label} title={title} width={dimensions?.width} height={dimensions?.height}
    loading={preloading ? "eager" : "lazy"} decoding="async" referrerPolicy="no-referrer"
    onLoad={async ({ currentTarget: img }) => {
      if (preloading) {
        try { await img.decode(); }
        catch { if (img.isConnected) onError(); return; }
        if (!img.isConnected) return;
        setLocalSrc(undefined);
      }
      rememberDimensions(url, img.naturalWidth, img.naturalHeight);
      onLoad?.();
    }} onError={() => {
      if (url === src) onError();
      else setLocalSrc(undefined);
      onLoad?.();
    }}
    className={cn(layout === "inline" ? "rounded-lg" : "rounded-2xl",
      layout === "tile" ? "size-full object-cover" : "max-h-96 max-w-full object-contain",
      layout === "single" && ["h-auto", singleWidth ? "w-full" : "w-auto"],
    )} />;
  const image = <>{fallback && thumbnail(fallback)}{thumbnail(src, !!fallback)}</>;
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
    <ImageViewerContent src={fallback ?? src} label={label} kind="image" onError={onError} />
  </Dialog>;
}
