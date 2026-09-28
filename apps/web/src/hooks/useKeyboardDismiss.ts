import { useEffect, type RefObject } from "react";

// Android can resize both viewports; Safari only resizes the visual viewport.
// Remember the unoccluded height before focus instead of relying on their gap.
export function useKeyboardDismiss(input: RefObject<HTMLInputElement | HTMLTextAreaElement | null>) {
  useEffect(() => {
    const el = input.current;
    if (!el || !window.matchMedia("(pointer: coarse)").matches) return;
    const viewport = window.visualViewport;
    const height = () => Math.min(window.innerHeight, viewport?.height ?? window.innerHeight);
    let baseline = height();
    let width = window.innerWidth;
    let opened = false;
    const reset = () => { opened = false; };
    const measure = () => {
      // Zoom and rotation are not keyboard dismissal. Start a new baseline.
      if (viewport && viewport.scale !== 1) { reset(); return; }
      const current = height();
      if (Math.abs(window.innerWidth - width) > 1) {
        width = window.innerWidth; baseline = current; reset(); return;
      }
      baseline = Math.max(baseline, current);
      if (document.activeElement !== el) return;
      const occluded = baseline - current;
      // Hysteresis ignores browser chrome and intermediate keyboard frames.
      if (occluded > 150) opened = true;
      else if (opened && occluded < 80) {
        reset();
        el.blur();
      }
    };
    el.addEventListener("focus", measure);
    el.addEventListener("blur", reset);
    window.addEventListener("resize", measure);
    viewport?.addEventListener("resize", measure);
    return () => {
      el.removeEventListener("focus", measure);
      el.removeEventListener("blur", reset);
      window.removeEventListener("resize", measure);
      viewport?.removeEventListener("resize", measure);
    };
  }, [input]);
}
