import { useEffect, useRef } from "react";
import type { TaskHistoryState } from "../task-history-state";

// Keep enough loaded history ahead of an upward reader for both the request and
// row measurement. Never overlap page requests or let a fast fling fetch without
// a bound; the stream hook owns the single in-flight pagination request.
export function useHistoryPrefetch({ earlier, loadEarlier }: {
  earlier?: TaskHistoryState["earlier"];
  loadEarlier?: () => void;
}) {
  const loadingEarlier = earlier?.status === "loading";
  const sentinel = useRef<HTMLDivElement>(null);
  const request = useRef({ started: 0, duration: 1000 });
  const motion = useRef({ at: 0, speed: 0 });

  useEffect(() => {
    if (loadingEarlier) request.current.started = performance.now();
    else if (request.current.started) {
      request.current.duration = Math.min(5000, Math.max(300, performance.now() - request.current.started));
      request.current.started = 0;
    }
  }, [loadingEarlier]);

  useEffect(() => {
    const target = sentinel.current;
    const root = target?.closest<HTMLElement>("[data-radix-scroll-area-viewport]");
    if (!target || !root || !earlier || !["idle", "loading"].includes(earlier.status)) return;
    let observer: IntersectionObserver | undefined;
    let margin = 0;
    let ready = false;
    const observe = () => {
      if (!ready || loadingEarlier) return;
      const height = root.clientHeight;
      const speed = motion.current.speed * Math.max(0, 1 - (performance.now() - motion.current.at) / 1000);
      // Round only the additional runway; slow reading keeps the usual floor.
      const extra = Math.max(0, speed - 0.5) * (request.current.duration + 250);
      const nextMargin = Math.min(Math.max(1200, height * 12), Math.max(1200, height * 3) + Math.ceil(extra / Math.max(1, height)) * height);
      if (nextMargin === margin) return;
      margin = nextMargin;
      observer?.disconnect();
      observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) loadEarlier?.();
      }, { root, rootMargin: `${margin}px 0px 0px` });
      observer.observe(target);
    };
    const record = (distance: number, since = motion.current.at) => {
      const at = performance.now();
      const elapsed = Math.max(16, Math.min(250, at - since));
      motion.current = { at, speed: distance > 0 ? Math.max(distance / elapsed, elapsed < 250 ? motion.current.speed * 0.8 : 0) : 0 };
      observe();
    };
    // Measure reader input, not scrollTop writes from virtualization. Those
    // corrections can change coordinates without changing total scroll height.
    const wheel = (event: WheelEvent) => {
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? root.clientHeight : 1;
      record(-event.deltaY * unit);
    };
    let touch: { y: number; at: number } | undefined;
    const touchStart = (event: TouchEvent) => {
      touch = event.touches.length === 1 ? { y: event.touches[0].clientY, at: performance.now() } : undefined;
    };
    const touchMove = (event: TouchEvent) => {
      if (touch && event.touches.length === 1) record(event.touches[0].clientY - touch.y, touch.at);
      touchStart(event);
    };
    const resize = new ResizeObserver(observe);
    const observeWhenReady = () => {
      const list = root.querySelector<HTMLElement>("[data-transcript-items]");
      if (list && getComputedStyle(list).visibility === "hidden") {
        frame = requestAnimationFrame(observeWhenReady);
      } else {
        ready = true;
        observe();
        resize.observe(root);
      }
    };
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(observeWhenReady); });
    root.addEventListener("scroll", observe, { passive: true });
    root.addEventListener("wheel", wheel, { passive: true });
    root.addEventListener("touchstart", touchStart, { passive: true });
    root.addEventListener("touchmove", touchMove, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      observer?.disconnect();
      root.removeEventListener("scroll", observe);
      root.removeEventListener("wheel", wheel);
      root.removeEventListener("touchstart", touchStart);
      root.removeEventListener("touchmove", touchMove);
    };
  }, [earlier?.status, loadingEarlier, loadEarlier]);

  return sentinel;
}
