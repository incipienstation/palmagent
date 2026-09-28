import { useState } from "react";
import { Maximize, Minus, Plus, RotateCcw, X } from "lucide-react";
import { TransformComponent, TransformWrapper, useControls, useTransformComponent } from "react-zoom-pan-pinch";
import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";

function Controls() {
  const { zoomIn, zoomOut, resetTransform } = useControls();
  const scale = useTransformComponent(({ state }) => state.scale);
  return <div className="flex shrink-0 items-center justify-end gap-1 border-b border-border px-2 py-1" role="group" aria-label="Diagram zoom controls">
    <span className="mr-auto px-1 text-xs tabular-nums text-muted-foreground" aria-label="Diagram zoom">{Math.round(scale * 100)}%</span>
    <Button type="button" variant="ghost" size="icon-lg" aria-label="Zoom out diagram" title="Zoom out" disabled={scale <= 1} onClick={() => zoomOut(0.4, 0)}><Minus /></Button>
    <Button type="button" variant="ghost" size="icon-lg" aria-label="Zoom in diagram" title="Zoom in" disabled={scale >= 8} onClick={() => zoomIn(0.4, 0)}><Plus /></Button>
    <Button type="button" variant="ghost" size="icon-lg" aria-label="Fit diagram" title="Fit diagram" onClick={() => resetTransform(0)}><RotateCcw /></Button>
  </div>;
}

function Viewer({ url }: { url: string }) {
  return <TransformWrapper minScale={1} maxScale={8} smooth={false}
    wheel={{ activationKeys: keys => keys.includes("Control") || keys.includes("Meta") }} trackPadPanning={{ disabled: true }}
    panning={{ velocityDisabled: true }} pinch={{ allowPanning: true }}
    keyboard={{ disabled: false, panStep: 40, zoomStep: 0.4, animationTime: 0 }}
    doubleClick={{ mode: "toggle", step: 1, animationTime: 0 }} zoomAnimation={{ disabled: true }}
    autoAlignment={{ animationTime: 0 }}>
    <Controls />
    <div className="min-h-0 flex-1 overflow-hidden">
      <TransformComponent wrapperClass="touch-none cursor-grab outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing"
        wrapperProps={{ role: "region", "aria-label": "Mermaid diagram" }}
        wrapperStyle={{ width: "100%", height: "100%" }}
        contentStyle={{ width: "100%", height: "100%", alignItems: "center", justifyContent: "center" }}>
        <img src={url} alt="Mermaid diagram" draggable={false} className="max-h-[calc(100%-1.5rem)] max-w-[calc(100%-1.5rem)] select-none object-contain" />
      </TransformComponent>
    </div>
  </TransformWrapper>;
}

export default function MermaidViewport({ url }: { url: string }) {
  const [open, setOpen] = useState(false);
  return <Dialog open={open} onOpenChange={setOpen}>
    <div role="region" aria-label="Mermaid diagram" onDoubleClick={() => setOpen(true)}
      className="relative flex h-full touch-manipulation items-center justify-center overflow-hidden p-3">
      <img src={url} alt="Mermaid diagram" draggable={false} className="max-h-full max-w-full select-none object-contain" />
      <DialogTrigger asChild>
        <Button type="button" variant="secondary" size="icon-lg" className="absolute top-1 right-1"
          aria-label="Open diagram fullscreen" title="Open diagram fullscreen"><Maximize /></Button>
      </DialogTrigger>
    </div>
    <DialogContent showClose={false} aria-describedby={undefined}
      className="top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
      <DialogHeader className="shrink-0 flex-row items-center justify-between gap-2 border-b border-border px-3 py-1">
        <DialogTitle>Mermaid diagram</DialogTitle>
        <DialogClose asChild>
          <Button type="button" variant="ghost" size="icon-lg" aria-label="Exit diagram fullscreen" title="Close"><X /></Button>
        </DialogClose>
      </DialogHeader>
      <Viewer url={url} />
    </DialogContent>
  </Dialog>;
}
