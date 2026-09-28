import { useLayoutEffect, useRef, useState } from "react";
import { VOICE_METER_INTERVAL_MS } from "../voice-input";

export function VoiceWaveform({ levels }: { levels: number[] }) {
  const viewport = useRef<SVGSVGElement>(null);
  const track = useRef<SVGGElement>(null);
  const [width, setWidth] = useState(0);
  const pitch = Math.max(6, width / (levels.length - 1));

  useLayoutEffect(() => {
    const element = viewport.current!;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Each new sample shifts the history one bar left. Slide from its previous
    // position so recorded peaks travel intact instead of morphing in place.
    const animation = track.current?.animate([
      { transform: `translateX(${pitch}px)` }, { transform: "translateX(0)" },
    ], { duration: VOICE_METER_INTERVAL_MS, easing: "linear" });
    return () => animation?.cancel();
  }, [levels, pitch]);

  return <svg ref={viewport} aria-hidden="true" data-voice-waveform
    className="h-8 min-w-0 flex-1 overflow-hidden fill-muted-foreground/75">
    <g ref={track}>
      {levels.map((level, index) => {
        const x = width - 3 - (levels.length - 1 - index) * pitch;
        if (x < -pitch) return null;
        const height = 4 + Math.min(1, Math.max(0, level)) * 24;
        return <rect key={index} x={x} y={(32 - height) / 2} width={3} height={height} rx={1.5} />;
      })}
    </g>
  </svg>;
}
