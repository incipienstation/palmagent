import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Download, ExternalLink, X } from "lucide-react";
import { downloadImage, isRemoteImage } from "../image-download";
import { Button } from "./ui/button";
import { DialogClose, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

const ZoomableImage = lazy(() => import("./ZoomableImage"));

type ImageViewerProps = {
  src: string; label: string; kind: "image" | "diagram"; onError?: () => void;
};

export function ImageViewerContent(props: ImageViewerProps) {
  return <DialogContent showClose={false} aria-describedby={undefined}
    className="top-0 left-0 flex h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
    <ImageViewerBody key={props.src} {...props} />
  </DialogContent>;
}

function ImageViewerBody({ src, label, kind, onError }: ImageViewerProps) {
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function download() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setDownloading(true);
    setDownloadFailed(false);
    try { await downloadImage(src, controller.signal); }
    catch { if (!controller.signal.aborted) setDownloadFailed(true); }
    finally {
      request.current = null;
      if (!controller.signal.aborted) setDownloading(false);
    }
  }
  return <>
    <DialogHeader className="shrink-0 flex-row items-center justify-between gap-2 border-b border-border px-3 py-1">
      <DialogTitle className="min-w-0 truncate" title={label}>{label}</DialogTitle>
      <div className="flex shrink-0 items-center gap-1">
        {kind === "image" && (isRemoteImage(src) ? <Button asChild variant="ghost" size="icon-lg">
          <a href={src} target="_blank" rel="noopener noreferrer" aria-label="Open original image" title="Open original image"><ExternalLink /></a>
        </Button> : <Button type="button" variant="ghost" size="icon-lg" onClick={() => void download()}
          disabled={downloading} aria-busy={downloading} aria-label={downloading ? "Downloading image" : "Download image"} title={downloading ? "Downloading…" : "Download image"}><Download /></Button>)}
        <DialogClose asChild>
          <Button type="button" variant="ghost" size="icon-lg" aria-label={`Exit ${kind} fullscreen`} title="Close"><X /></Button>
        </DialogClose>
      </div>
    </DialogHeader>
    {downloadFailed && <p role="alert" className="shrink-0 px-3 py-2 text-sm text-destructive">Could not download image. Please try again.</p>}
    <Suspense fallback={<p className="p-3 text-sm text-muted-foreground" role="status">Loading viewer…</p>}>
      <ZoomableImage src={src} label={label} kind={kind} onError={onError} />
    </Suspense>
  </>;
}
