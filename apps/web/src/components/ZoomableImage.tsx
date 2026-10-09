import { Minus, Plus, RotateCcw } from "lucide-react";
import { TransformComponent, TransformWrapper, useControls, useTransformComponent } from "react-zoom-pan-pinch";
import { Button } from "./ui/button";

function Controls({ kind }: { kind: "image" | "diagram" }) {
  const { zoomIn, zoomOut, resetTransform } = useControls();
  const scale = useTransformComponent(({ state }) => state.scale);
  return <div className="flex shrink-0 items-center justify-end gap-1 border-b border-border px-2 py-1" role="group" aria-label={`${kind === "diagram" ? "Diagram" : "Image"} zoom controls`}>
    <span className="mr-auto px-1 text-xs tabular-nums text-muted-foreground" aria-label={`${kind === "diagram" ? "Diagram" : "Image"} zoom`}>{Math.round(scale * 100)}%</span>
    <Button type="button" variant="ghost" size="icon-lg" aria-label={`Zoom out ${kind}`} title="Zoom out" disabled={scale <= 1} onClick={() => zoomOut(0.4, 0)}><Minus /></Button>
    <Button type="button" variant="ghost" size="icon-lg" aria-label={`Zoom in ${kind}`} title="Zoom in" disabled={scale >= 8} onClick={() => zoomIn(0.4, 0)}><Plus /></Button>
    <Button type="button" variant="ghost" size="icon-lg" aria-label={`Fit ${kind}`} title="Fit to screen" onClick={() => resetTransform(0)}><RotateCcw /></Button>
  </div>;
}

export default function ZoomableImage({ src, label, kind, onError }: {
  src: string; label: string; kind: "image" | "diagram"; onError?: () => void;
}) {
  return <TransformWrapper minScale={1} maxScale={8} smooth={false}
    wheel={{ activationKeys: keys => keys.includes("Control") || keys.includes("Meta") }} trackPadPanning={{ disabled: true }}
    panning={{ velocityDisabled: true }} pinch={{ allowPanning: true }}
    keyboard={{ disabled: false, panStep: 40, zoomStep: 0.4, animationTime: 0 }}
    doubleClick={{ mode: "toggle", step: 1, animationTime: 0 }} zoomAnimation={{ disabled: true }}
    autoAlignment={{ animationTime: 0 }}>
    <Controls kind={kind} />
    <div className="min-h-0 flex-1 overflow-hidden">
      <TransformComponent wrapperClass="touch-none cursor-grab outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing"
        wrapperProps={{ role: "region", "aria-label": label }}
        wrapperStyle={{ width: "100%", height: "100%" }}
        contentStyle={{ width: "100%", height: "100%", alignItems: "center", justifyContent: "center" }}>
        <img src={src} alt={label} referrerPolicy="no-referrer" onError={onError} draggable={false} className="max-h-[calc(100%-1.5rem)] max-w-[calc(100%-1.5rem)] select-none object-contain" />
      </TransformComponent>
    </div>
  </TransformWrapper>;
}
