import { useId } from "react";
import { Maximize, Minus, Plus, RotateCcw, X } from "lucide-react";
import { TransformComponent, TransformWrapper, useControls, useTransformComponent } from "react-zoom-pan-pinch";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";

function Controls({ fullscreen }: { fullscreen: boolean }) {
  const { zoomIn, zoomOut, resetTransform } = useControls();
  const scale = useTransformComponent(({ state }) => state.scale);
  return <div className="flex shrink-0 items-center justify-end gap-1 border-b border-border px-2 py-1" role="group" aria-label="Diagram zoom controls">
    <span className="mr-auto px-1 text-xs tabular-nums text-muted-foreground" aria-label="Diagram zoom">{Math.round(scale * 100)}%</span>
    <Button type="button" variant="ghost" size="icon-lg" aria-label="Zoom out diagram" disabled={scale <= 1} onClick={() => zoomOut(0.4, 0)}><Minus /></Button>
    <Button type="button" variant="ghost" size="icon-lg" aria-label="Zoom in diagram" disabled={scale >= 8} onClick={() => zoomIn(0.4, 0)}><Plus /></Button>
    <Button type="button" variant="ghost" size="icon-lg" aria-label="Fit diagram" title="Fit diagram" onClick={() => resetTransform(0)}><RotateCcw /></Button>
    {!fullscreen && <DialogTrigger asChild>
      <Button type="button" variant="ghost" size="icon-lg" aria-label="Open diagram fullscreen" title="Open diagram fullscreen"><Maximize /></Button>
    </DialogTrigger>}
  </div>;
}

function Canvas({ url, fullscreen }: { url: string; fullscreen: boolean }) {
  const helpId = useId();
  return <>
    <div className={cn("overflow-hidden", fullscreen ? "min-h-0 flex-1" : "h-[min(50dvh,24rem)] min-h-44")}>
      <TransformComponent wrapperClass="touch-none cursor-grab outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing"
        wrapperProps={{ role: "region", "aria-label": "Mermaid diagram", "aria-describedby": helpId }}
        wrapperStyle={{ width: "100%", height: "100%" }}
        contentStyle={{ width: "100%", height: "100%", alignItems: "center", justifyContent: "center" }}>
        <img src={url} alt="Mermaid diagram" draggable={false} className="max-h-[calc(100%-1.5rem)] max-w-[calc(100%-1.5rem)] select-none object-contain" />
      </TransformComponent>
    </div>
    <p id={helpId} className="shrink-0 px-3 py-2 text-xs text-muted-foreground">Drag to pan · Pinch or Ctrl/⌘ + scroll to zoom<span className="sr-only">. Keyboard: + and - to zoom, arrow keys to pan, 0 to fit.</span></p>
  </>;
}

function Viewer({ url, fullscreen = false }: { url: string; fullscreen?: boolean }) {
  return <TransformWrapper minScale={1} maxScale={8} smooth={false}
    wheel={{ activationKeys: keys => keys.includes("Control") || keys.includes("Meta") }} trackPadPanning={{ disabled: true }}
    panning={{ velocityDisabled: true }} pinch={{ allowPanning: true }}
    keyboard={{ disabled: false, panStep: 40, zoomStep: 0.4, animationTime: 0 }}
    doubleClick={{ mode: "toggle", step: 1, animationTime: 0 }} zoomAnimation={{ disabled: true }}
    autoAlignment={{ animationTime: 0 }}>
    <Controls fullscreen={fullscreen} />
    <Canvas url={url} fullscreen={fullscreen} />
  </TransformWrapper>;
}

export default function MermaidViewport({ url }: { url: string }) {
  return <Dialog>
    <Viewer url={url} />
    <DialogContent showClose={false} aria-describedby={undefined}
      className="top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
      <DialogHeader className="shrink-0 flex-row items-center justify-between gap-2 border-b border-border px-3 py-1">
        <DialogTitle>Mermaid diagram</DialogTitle>
        <DialogClose asChild>
          <Button type="button" variant="ghost" size="icon-lg" aria-label="Exit diagram fullscreen"><X /></Button>
        </DialogClose>
      </DialogHeader>
      <Viewer url={url} fullscreen />
    </DialogContent>
  </Dialog>;
}
