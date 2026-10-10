import { useLayoutEffect, useRef, useState, type RefObject } from "react";

// Keep the textarea as the scroll owner so native caret following, selection,
// and IME editing still work. Only the scrollbar is drawn outside its layout.
export function ComposerScrollbar({ textarea, value }: { textarea: RefObject<HTMLTextAreaElement | null>; value: string }) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; top: number } | null>(null);
  const [metrics, setMetrics] = useState({ top: 0, max: 0, height: 0, thumb: 0 });
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    const update = () => {
      const height = Math.max(0, el.clientHeight - 16);
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      const next = { top: Math.max(0, Math.min(el.scrollTop, max)), max, height,
        thumb: Math.min(height, Math.max(18, height * el.clientHeight / (el.scrollHeight || 1))) };
      setMetrics(previous => previous.top === next.top && previous.max === next.max && previous.height === next.height && previous.thumb === next.thumb ? previous : next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    el.addEventListener("scroll", update);
    // Wheel events over the overlay must scroll the same textarea, not the page.
    const bar = track.current;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      el.scrollTop += event.deltaY * (event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? el.clientHeight : 1);
    };
    bar?.addEventListener("wheel", wheel, { passive: false });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", update);
      bar?.removeEventListener("wheel", wheel);
    };
  }, [textarea, value]);
  const travel = metrics.height - metrics.thumb;
  const offset = metrics.max ? metrics.top / metrics.max * travel : 0;
  return <div ref={track} role="scrollbar" aria-label="Scroll message" aria-controls={textarea.current?.id}
    aria-orientation="vertical" aria-valuemin={0} aria-valuemax={Math.round(metrics.max)} aria-valuenow={Math.round(metrics.top)}
    hidden={!metrics.max || !travel} tabIndex={0}
    className="composer-scrollbar absolute inset-y-2 right-0 w-2.5 touch-none select-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
    onPointerDown={event => {
      if (event.button !== 0 || !textarea.current) return;
      event.preventDefault();
      const y = event.clientY - event.currentTarget.getBoundingClientRect().top;
      if (y < offset || y > offset + metrics.thumb) textarea.current.scrollTop = (y - metrics.thumb / 2) / travel * metrics.max;
      drag.current = { y: event.clientY, top: textarea.current.scrollTop };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      if (drag.current && textarea.current) textarea.current.scrollTop = drag.current.top + (event.clientY - drag.current.y) / travel * metrics.max;
    }}
    onPointerUp={event => {
      drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onLostPointerCapture={() => { drag.current = null; }}
    onKeyDown={event => {
      const el = textarea.current;
      if (!el) return;
      const positions: Record<string, number> = { ArrowUp: el.scrollTop - 24, ArrowDown: el.scrollTop + 24,
        PageUp: el.scrollTop - el.clientHeight, PageDown: el.scrollTop + el.clientHeight, Home: 0, End: metrics.max };
      if (event.key in positions) {
        event.preventDefault();
        event.stopPropagation();
        el.scrollTop = positions[event.key]!;
      }
    }}>
    <div aria-hidden="true" className="composer-scrollbar-thumb absolute inset-x-px rounded-full bg-border"
      style={{ height: metrics.thumb, transform: `translateY(${offset}px)` }} />
  </div>;
}
