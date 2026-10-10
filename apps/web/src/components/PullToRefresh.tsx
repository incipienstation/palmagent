import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui";

import { ScrollBar } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

const positions = new Map<string, number>();

const THRESHOLD = 64; // px of pull (after damping) needed to trigger a refresh
const MAX = 96; // max visual pull
const DAMP = 0.5; // resistance: finger travel → visual travel

// Custom pull-to-refresh. index.css locks the document to the viewport and an
// installed PWA has no native overscroll gesture, so we synthesize one on the
// inner scroll pane: drag down from the top past a threshold and `onRefresh`
// refreshes the data in place. Visuals are driven imperatively via
// refs — not React state — so a long list never re-renders mid-touchmove. Touch
// listeners are attached natively so touchmove can be non-passive (preventDefault
// is needed to suppress the browser's own scroll/bounce while we own the pull).
export function PullToRefresh({
  onRefresh,
  scrollKey,
  className,
  children,
}: {
  onRefresh: () => void | Promise<void>;
  scrollKey?: string;
  className?: string;
  children: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const spinnerRef = useRef<HTMLDivElement>(null);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !scrollKey) return;
    let top = positions.get(scrollKey) ?? 0;
    el.scrollTop = top;
    const remember = () => { top = el.scrollTop; };
    el.addEventListener("scroll", remember, { passive: true });
    return () => {
      el.removeEventListener("scroll", remember);
      positions.delete(scrollKey);
      positions.set(scrollKey, top);
      if (positions.size > 50) positions.delete(positions.keys().next().value!);
    };
  }, [scrollKey]);

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    const spinner = spinnerRef.current;
    if (!el || !content || !spinner) return;

    let startY = 0;
    let startX = 0;
    let vertical = false;
    let armed = false; // gesture began at the top of the pane
    let pulling = false; // currently dragging down past the top
    let offset = 0;
    let busy = false;
    let disposed = false;

    const paint = (px: number, animate: boolean) => {
      content.style.transition = animate ? "transform 200ms ease" : "";
      spinner.style.transition = animate ? "opacity 200ms ease" : "";
      content.style.transform = px ? `translateY(${px}px)` : "";
      spinner.style.opacity = String(Math.min(1, px / THRESHOLD));
    };

    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (busy || !t || e.touches.length !== 1 || el.scrollTop > 0) {
        if (pulling) paint((offset = 0), false);
        pulling = false;
        armed = false;
        return;
      }
      armed = true;
      pulling = false;
      offset = 0;
      startY = t.clientY;
      startX = t.clientX;
      vertical = false;
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!armed || busy || !t) return;
      if (e.touches.length !== 1) {
        armed = false; pulling = false;
        paint((offset = 0), false);
        return;
      }
      if (el.scrollTop > 0) {
        if (pulling) paint((offset = 0), false);
        pulling = false;
        armed = false;
        return;
      }
      const delta = t.clientY - startY;
      if (!vertical) {
        const dx = Math.abs(t.clientX - startX);
        if (Math.max(dx, Math.abs(delta)) < 10) return;
        if (dx > Math.abs(delta)) { armed = false; return; }
        vertical = true;
      }
      if (delta <= 0) {
        if (pulling) paint((offset = 0), false);
        pulling = false;
        return;
      }
      pulling = true;
      e.preventDefault(); // we own this gesture — suppress native scroll/bounce
      offset = Math.min(MAX, delta * DAMP);
      paint(offset, false);
    };
    const onEnd = () => {
      if (!armed) return;
      armed = false;
      if (pulling && offset >= THRESHOLD) {
        busy = true;
        setRefreshing(true);
        // Release the content immediately so a slow refresh cannot hide the
        // bottom of the list. Progress floats above the unchanged viewport.
        paint(0, true);
        setError("");
        Promise.resolve().then(() => onRefreshRef.current()).catch(() => {
          if (!disposed) setError("Could not refresh. Pull down to retry.");
        }).finally(() => {
          if (disposed) return;
          paint(0, true); setRefreshing(false); busy = false;
        });
      } else if (pulling) {
        paint(0, true);
      }
      pulling = false;
      offset = 0;
    };
    const onCancel = () => {
      armed = false; pulling = false; offset = 0;
      paint(0, true);
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onCancel, { passive: true });
    return () => {
      disposed = true;
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onCancel);
    };
  }, []);

  return (
    <ScrollAreaPrimitive.Root className={cn("relative overflow-hidden", className)}>
      <ScrollAreaPrimitive.Viewport ref={scrollRef} style={{ overflowAnchor: "none" }} className="h-full w-full overscroll-contain">
        <div ref={contentRef}>
          {/* Spinner sits one row above the content (negative margin) so it's
              hidden until a pull translates the content down into view. */}
          <div ref={spinnerRef} className="-mt-12 flex h-12 items-center justify-center opacity-0" aria-hidden>
            <span className="flex size-8 items-center justify-center rounded-full border border-border bg-card/95 shadow-sm backdrop-blur-md">
              <RefreshCw className={cn("size-4 text-primary", refreshing && "animate-spin")} />
            </span>
          </div>
          {error && <p role="alert" className="px-4 py-2 text-sm text-destructive">{error}</p>}
          {children}
        </div>
      </ScrollAreaPrimitive.Viewport>
      {refreshing && <div role="status" className="pointer-events-none absolute inset-x-0 top-2 flex justify-center">
        <span className="rounded-full bg-card px-3 py-1 text-xs text-muted-foreground shadow-sm">Refreshing…</span>
      </div>}
      <ScrollBar />
    </ScrollAreaPrimitive.Root>
  );
}
