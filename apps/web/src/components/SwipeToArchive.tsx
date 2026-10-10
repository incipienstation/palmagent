import { useEffect, useRef, useState, type ReactNode } from "react";
import { Archive } from "lucide-react";
import { Button } from "./ui/button";

const WIDTH = 104;

/** A horizontal touch reveals an explicit action; dragging never archives. */
export function SwipeToArchive({ children, disabled, onArchive }: {
  children: ReactNode;
  disabled: boolean;
  onArchive: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const opened = useRef(false);
  const suppressClick = useRef(false);
  const close = useRef(() => {});

  useEffect(() => {
    const element = root.current;
    const content = surface.current;
    if (!element || !content) return;
    let gesture: { x: number; y: number; offset: number; horizontal: boolean } | undefined;
    let offset = 0;
    const paint = (value: number, animate: boolean) => {
      content.style.transition = animate && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "transform 180ms ease" : "none";
      content.style.transform = `translateX(${value}px)`;
    };
    const settle = (next: boolean) => {
      opened.current = next;
      setOpen(next);
      offset = next ? -WIDTH : 0;
      paint(offset, true);
    };
    const cancel = () => {
      gesture = undefined;
      settle(false);
    };
    close.current = cancel;
    const start = (event: TouchEvent) => {
      if (event.touches.length !== 1) { cancel(); return; }
      suppressClick.current = false;
      const target = event.target;
      // Menus and PR controls keep their own gestures and taps.
      if (disabled || !(target instanceof Element) || !target.closest("button[data-swipe-surface]")) return;
      if (target.closest("button") !== target.closest("button[data-swipe-surface]")) return;
      const touch = event.touches[0]!;
      gesture = { x: touch.clientX, y: touch.clientY, offset, horizontal: false };
    };
    const move = (event: TouchEvent) => {
      if (!gesture) return;
      if (event.touches.length !== 1) { cancel(); return; }
      const touch = event.touches[0]!;
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      if (!gesture.horizontal) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return;
        if (Math.abs(dx) <= Math.abs(dy) * 1.3 || (!opened.current && dx > 0)) {
          gesture = undefined;
          return;
        }
        gesture.horizontal = true;
        suppressClick.current = true;
      }
      if (event.cancelable) event.preventDefault();
      event.stopPropagation(); // Do not also pull the surrounding list to refresh.
      offset = Math.max(-WIDTH, Math.min(0, gesture.offset + dx));
      paint(offset, false);
    };
    const end = () => {
      if (gesture?.horizontal) settle(offset < -WIDTH / 2);
      gesture = undefined;
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !element.contains(event.target)) cancel();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
    if (disabled) cancel();
    element.addEventListener("touchstart", start, { passive: true });
    element.addEventListener("touchmove", move, { passive: false });
    element.addEventListener("touchend", end);
    element.addEventListener("touchcancel", cancel);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      element.removeEventListener("touchstart", start);
      element.removeEventListener("touchmove", move);
      element.removeEventListener("touchend", end);
      element.removeEventListener("touchcancel", cancel);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [disabled]);

  return <div ref={root} className="relative overflow-hidden" data-swipe-row="" onPointerDownCapture={() => { suppressClick.current = false; }} onClickCapture={event => {
    // Portaled menus are not part of the sliding row.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    if (suppressClick.current && event.detail !== 0) {
      suppressClick.current = false;
      event.preventDefault(); event.stopPropagation();
    } else if (opened.current && event.target instanceof Element && event.target.closest("button[data-swipe-surface]")) {
      close.current();
      event.preventDefault(); event.stopPropagation();
    }
  }}>
    <div className="absolute inset-y-0 right-0 w-26" aria-hidden={!open || disabled} inert={!open || disabled ? true : undefined}>
      <Button variant="secondary" className="size-full flex-col rounded-none" onClick={onArchive} disabled={disabled || !open}>
        <Archive />Archive
      </Button>
    </div>
    <div ref={surface} className="relative bg-background">{children}</div>
  </div>;
}
