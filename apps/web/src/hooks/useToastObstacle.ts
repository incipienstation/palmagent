import { useCallback, useRef } from "react";

// Bottom controls register their actual bounds, including safe areas, queue
// rows and update banners. The app-wide toaster lives outside these containers.
const obstacles = new Set<HTMLElement>();
let frame = 0;

export function updateToastClearance() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    let bottom = 0;
    for (const element of obstacles) {
      const rect = element.getBoundingClientRect();
      if (rect.width && rect.height) bottom = Math.max(bottom, window.innerHeight - rect.top + 24);
    }
    document.documentElement.style.setProperty("--toast-obstacle-bottom", `${bottom}px`);
  });
}

/** Attach to a bottom control or footer that a toast must not cover. */
export function useToastObstacle() {
  const previous = useRef<HTMLElement | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  return useCallback((element: HTMLElement | null) => {
    observer.current?.disconnect();
    if (previous.current) {
      obstacles.delete(previous.current);
      previous.current.removeEventListener("transitionend", updateToastClearance);
    }
    previous.current = element;
    if (element) {
      obstacles.add(element);
      element.addEventListener("transitionend", updateToastClearance);
      observer.current = new ResizeObserver(updateToastClearance);
      observer.current.observe(element);
    }
    updateToastClearance();
  }, []);
}
