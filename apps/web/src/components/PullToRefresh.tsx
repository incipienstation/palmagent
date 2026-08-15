import { useEffect, useRef, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui";

import { ScrollBar } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

const THRESHOLD = 64; // px of pull (after damping) needed to trigger a refresh
const MAX = 96; // max visual pull
const DAMP = 0.5; // resistance: finger travel → visual travel

// Custom pull-to-refresh. index.css locks the document to the viewport and an
// installed PWA has no native overscroll gesture, so we synthesize one on the
// inner scroll pane: drag down from the top past a threshold and `onRefresh`
// fires (typically a deploy-aware reload). Visuals are driven imperatively via
// refs — not React state — so a long list never re-renders mid-touchmove. Touch
// listeners are attached natively so touchmove can be non-passive (preventDefault
// is needed to suppress the browser's own scroll/bounce while we own the pull).
export function PullToRefresh({
  onRefresh,
  className,
  children,
}: {
  onRefresh: () => void;
  className?: string;
  children: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const spinnerRef = useRef<HTMLDivElement>(null);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    const spinner = spinnerRef.current;
    if (!el || !content || !spinner) return;

    let startY = 0;
    let armed = false; // gesture began at the top of the pane
    let pulling = false; // currently dragging down past the top
    let offset = 0;
    let busy = false; // refresh fired — ignore further input (page is reloading)

    const paint = (px: number, animate: boolean) => {
      content.style.transition = animate ? "transform 200ms ease" : "";
      spinner.style.transition = animate ? "opacity 200ms ease" : "";
      content.style.transform = px ? `translateY(${px}px)` : "";
      spinner.style.opacity = String(Math.min(1, px / THRESHOLD));
    };

    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (busy || !t || el.scrollTop > 0) {
        armed = false;
        return;
      }
      armed = true;
      pulling = false;
      offset = 0;
      startY = t.clientY;
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!armed || busy || !t) return;
      if (el.scrollTop > 0) {
        if (pulling) paint((offset = 0), false);
        pulling = false;
        armed = false;
        return;
      }
      const delta = t.clientY - startY;
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
        paint(THRESHOLD, true);
        onRefreshRef.current(); // typically reloads — this component then unmounts
        // reloadApp() is usually synchronous (window.location.reload), but when a
        // SW update is pending, updateSW() resolves async. The translateY stays at
        // THRESHOLD during that window, shrinking the visible scroll area and making
        // the bottom of the list unreachable. Reset after 500ms if still mounted.
        setTimeout(() => {
          if (busy) {
            paint(0, true);
            setRefreshing(false);
            busy = false;
          }
        }, 500);
      } else if (pulling) {
        paint(0, true);
      }
      pulling = false;
      offset = 0;
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  return (
    <ScrollAreaPrimitive.Root className={cn("relative overflow-hidden", className)}>
      <ScrollAreaPrimitive.Viewport ref={scrollRef} className="h-full w-full overscroll-contain">
        <div ref={contentRef}>
          {/* Spinner sits one row above the content (negative margin) so it's
              hidden until a pull translates the content down into view. */}
          <div ref={spinnerRef} className="-mt-12 flex h-12 items-center justify-center opacity-0" aria-hidden>
            <span className="flex size-8 items-center justify-center rounded-full border border-border bg-card/95 shadow-sm backdrop-blur-md">
              <RefreshCw className={cn("size-4 text-blue", refreshing && "animate-spin")} />
            </span>
          </div>
          {children}
        </div>
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
    </ScrollAreaPrimitive.Root>
  );
}
