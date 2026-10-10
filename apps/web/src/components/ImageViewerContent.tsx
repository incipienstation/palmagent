import { lazy, Suspense } from "react";
import { X } from "lucide-react";
import { Button } from "./ui/button";
import { DialogClose, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

const ZoomableImage = lazy(() => import("./ZoomableImage"));

export function ImageViewerContent({ src, label, kind, onError }: {
  src: string; label: string; kind: "image" | "diagram"; onError?: () => void;
}) {
  return <DialogContent showClose={false} aria-describedby={undefined}
    className="top-0 left-0 flex h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
    <DialogHeader className="shrink-0 flex-row items-center justify-between gap-2 border-b border-border px-3 py-1">
      <DialogTitle className="min-w-0 truncate" title={label}>{label}</DialogTitle>
      <DialogClose asChild>
        <Button type="button" variant="ghost" size="icon-lg" aria-label={`Exit ${kind} fullscreen`} title="Close"><X /></Button>
      </DialogClose>
    </DialogHeader>
    <Suspense fallback={<p className="p-3 text-sm text-muted-foreground" role="status">Loading viewer…</p>}>
      <ZoomableImage src={src} label={label} kind={kind} onError={onError} />
    </Suspense>
  </DialogContent>;
}
