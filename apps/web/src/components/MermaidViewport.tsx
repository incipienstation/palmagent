import { useId } from "react";
import { Maximize, Minus, Plus } from "lucide-react";
import { TransformComponent, TransformWrapper, useControls, useTransformComponent } from "react-zoom-pan-pinch";
import { Button } from "./ui/button";

function Controls() {
  const { zoomIn, zoomOut, resetTransform } = useControls();
  const scale = useTransformComponent(({ state }) => state.scale);
  return <div className="flex items-center justify-end gap-1 border-b border-border px-2 py-1" role="group" aria-label="Diagram zoom controls">
    <span className="mr-auto px-1 text-xs tabular-nums text-muted-foreground" aria-label="Diagram zoom">{Math.round(scale * 100)}%</span>
    <Button type="button" variant="ghost" size="icon-lg" aria-label="Zoom out diagram" disabled={scale <= 1} onClick={() => zoomOut(0.4, 0)}><Minus /></Button>
    <Button type="button" variant="ghost" size="icon-lg" aria-label="Zoom in diagram" disabled={scale >= 8} onClick={() => zoomIn(0.4, 0)}><Plus /></Button>
    <Button type="button" variant="ghost" size="icon-lg" aria-label="Fit diagram" onClick={() => resetTransform(0)}><Maximize /></Button>
  </div>;
}

function Canvas({ url }: { url: string }) {
  const helpId = useId();
  return <>
    <div className="h-[min(50dvh,24rem)] min-h-44 overflow-hidden">
      <TransformComponent wrapperClass="touch-none cursor-grab outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing"
        wrapperProps={{ role: "region", "aria-label": "Mermaid diagram", "aria-describedby": helpId }}
        wrapperStyle={{ width: "100%", height: "100%" }}
        contentStyle={{ width: "100%", height: "100%", alignItems: "center", justifyContent: "center" }}>
        <img src={url} alt="Mermaid diagram" draggable={false} className="max-h-[calc(100%-1.5rem)] max-w-[calc(100%-1.5rem)] select-none object-contain" />
      </TransformComponent>
    </div>
    <p id={helpId} className="px-3 py-2 text-xs text-muted-foreground">Drag to pan · Pinch or Ctrl/⌘ + scroll to zoom<span className="sr-only">. Keyboard: + and - to zoom, arrow keys to pan, 0 to fit.</span></p>
  </>;
}

export default function MermaidViewport({ url }: { url: string }) {
  return <TransformWrapper minScale={1} maxScale={8} smooth={false}
    wheel={{ activationKeys: keys => keys.includes("Control") || keys.includes("Meta") }} trackPadPanning={{ disabled: true }}
    panning={{ velocityDisabled: true }} pinch={{ allowPanning: true }}
    keyboard={{ disabled: false, panStep: 40, zoomStep: 0.4, animationTime: 0 }}
    doubleClick={{ mode: "toggle", step: 1, animationTime: 0 }} zoomAnimation={{ disabled: true }}
    autoAlignment={{ animationTime: 0 }}>
    <Controls />
    <Canvas url={url} />
  </TransformWrapper>;
}
