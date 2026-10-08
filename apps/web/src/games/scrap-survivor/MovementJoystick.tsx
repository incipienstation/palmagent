import { useCallback, useEffect, useId, useRef, useState, type PointerEvent } from "react";
import { type Point } from "./engine";

const travel = 32, deadZone = 4;
const center = { x: 0, y: 0 };

/** The visible resting stick invites dragging in the lower control area. */
export function MovementJoystick({ disabled, onMove }: { disabled: boolean; onMove: (point: Point) => void }) {
  const description = useId();
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const [anchor, setAnchor] = useState<Point | null>(null);
  const [rest, setRest] = useState<Point | null>(null);
  const [size, setSize] = useState(112);
  const [thumb, setThumb] = useState(center);
  const release = useCallback(() => {
    const id = drag.current?.id;
    drag.current = null;
    if (id !== undefined && surface.current?.hasPointerCapture(id)) surface.current.releasePointerCapture(id);
    setAnchor(null); setThumb(center); onMove(center);
  }, [onMove]);
  useEffect(() => { if (disabled) release(); }, [disabled, release]);
  useEffect(() => {
    window.addEventListener("blur", release);
    const resize = new ResizeObserver(() => {
      const box = surface.current?.getBoundingClientRect();
      if (!box) return;
      // Keep the entire stick inside the lower control area, including short screens.
      setSize(Math.min(112, box.height * 0.34));
      setRest({ x: box.width / 2, y: box.height * 0.8 });
      release();
    });
    if (surface.current) resize.observe(surface.current);
    return () => { window.removeEventListener("blur", release); resize.disconnect(); onMove(center); };
  }, [onMove, release]);
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || drag.current || event.button !== 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientY - box.top < box.height * 0.6) return;
    event.preventDefault();
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    setAnchor({ x: event.clientX - box.left, y: event.clientY - box.top });
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const held = drag.current;
    if (disabled || !held || held.id !== event.pointerId) return;
    const x = event.clientX - held.x, y = event.clientY - held.y, length = Math.hypot(x, y);
    const scale = Math.min(1, size * 0.285 / (length || 1));
    setThumb({ x: x * scale, y: y * scale });
    const speed = Math.min(1, Math.max(0, (length - deadZone) / (travel - deadZone)));
    onMove({ x: x / (length || 1) * speed, y: y / (length || 1) * speed });
  };
  const end = (event: PointerEvent<HTMLDivElement>) => { if (drag.current?.id === event.pointerId) release(); };
  return <div ref={surface} className="absolute inset-0 touch-none select-none" data-vaul-no-drag
    onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
    <button type="button" aria-label="Movement joystick" aria-describedby={description} disabled={disabled}
      aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight W A S D" onBlur={release}
      className="absolute flex size-28 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-primary/35 bg-primary/10 text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30"
      style={{ width: size, height: size, left: anchor?.x ?? rest?.x ?? "50%", top: anchor?.y ?? rest?.y ?? "calc(100% - 72px)" }}>
      <span aria-hidden="true" className="absolute inset-3 rounded-full border border-primary/15" />
      <span aria-hidden="true" className="rounded-full border border-primary/50 bg-primary/30 shadow-sm"
        style={{ width: size * 0.43, height: size * 0.43, transform: `translate(${thumb.x}px, ${thumb.y}px)` }} />
    </button>
    <span id={description} className="sr-only">Drag in the lower control area to move, or use arrow keys or WASD.</span>
  </div>;
}
