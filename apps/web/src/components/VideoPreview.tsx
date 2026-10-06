import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import { attachmentExpired } from "../image-source";
import { Button } from "./ui/button";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";

export function VideoPreview({ src, poster, label = "Attached video", compact = false, onLoad }: {
  src: string; poster?: string; label?: string; compact?: boolean; onLoad?: () => void;
}) {
  const [failed, setFailed] = useState(false), [expired, setExpired] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState<string>();
  useEffect(() => {
    if (!src.startsWith("data:")) { setSource(src); return; }
    // Blob URLs allow container sniffing, including MOV in browsers whose data
    // URL media loader rejects the video/quicktime MIME label.
    const comma = src.indexOf(","), data = atob(src.slice(comma + 1));
    const bytes = new Uint8Array(data.length);
    for (let index = 0; index < data.length; index++) bytes[index] = data.charCodeAt(index);
    const url = URL.createObjectURL(new Blob([bytes]));
    setSource(url);
    return () => URL.revokeObjectURL(url);
  }, [src]);
  useEffect(() => {
    if (!failed || !src.startsWith("/api/tasks/")) return;
    const controller = new AbortController();
    void attachmentExpired(src, controller.signal).then(value => { if (!controller.signal.aborted) setExpired(value); }).catch(() => {});
    return () => controller.abort();
  }, [failed, src]);
  if (failed) return <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
    <span>{expired ? "Video expired" : "Video unavailable"}</span>
    {!expired && <Button type="button" size="sm" variant="outline" onClick={() => { setFailed(false); setAttempt(attempt + 1); }}>Retry video</Button>}
  </div>;
  return <Dialog>
    <DialogTrigger asChild>
      <Button type="button" variant="ghost" className={compact ? "relative size-16 overflow-hidden rounded-xl p-0" : "relative my-2 h-auto max-w-full overflow-hidden rounded-lg p-0"} aria-label={`Play video: ${label}`}>
        {poster ? <img src={poster} alt="" className={compact ? "size-16 object-cover" : "max-h-48 max-w-full object-contain"} onLoad={onLoad} onError={onLoad} /> : <span className="p-4">{label}</span>}
        <span className="absolute inset-0 flex items-center justify-center"><span className="rounded-full bg-background/80 p-2"><Play /></span></span>
      </Button>
    </DialogTrigger>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-5xl flex-col overflow-hidden" aria-describedby={undefined}>
      <DialogBody contentClassName="flex flex-col gap-3" viewportProps={{ tabIndex: 0, "aria-label": "Video preview" }}>
        <DialogHeader className="pr-8"><DialogTitle className="break-words [overflow-wrap:anywhere]">{label}</DialogTitle></DialogHeader>
        <video key={attempt} src={source} poster={poster} controls playsInline preload="metadata" aria-label={label}
          className="max-h-[70dvh] w-full rounded-lg" onLoadedMetadata={onLoad} onError={() => { setFailed(true); onLoad?.(); }} />
        <p className="text-sm text-muted-foreground">Agents receive sampled frames. Audio is not included.</p>
      </DialogBody>
    </DialogContent>
  </Dialog>;
}
