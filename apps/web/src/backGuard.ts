import { dismissToast, toast } from "./components/ui/toaster";

const EXIT_WINDOW_MS = 2000;
let armedUntil = 0;
let hint: number | undefined;
let timer: number | undefined;
export function isStandalone(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches
    || (navigator as { standalone?: boolean }).standalone === true;
}
export function disarmExit(): void {
  armedUntil = 0;
  clearTimeout(timer);
  timer = undefined;
  const id = hint;
  hint = undefined;
  if (id !== undefined) dismissToast(id);
}
// Called only after navigating onto the single root floor. Reloads retain that
// floor, and deep links have a real inbox entry above it before their task page.
export function shouldExit(): boolean {
  if (Date.now() < armedUntil) { disarmExit(); return true; }
  disarmExit();
  const id = toast({ description: "Press back again to exit", variant: "info", duration: EXIT_WINDOW_MS,
    onClose: () => {
      if (hint !== id) return;
      hint = undefined;
      disarmExit();
    },
  });
  hint = id;
  armedUntil = Date.now() + EXIT_WINDOW_MS;
  // Sonner pauses its own timer on hover/focus. The exit window is a fixed
  // deadline, so remove its hint even when ordinary toast timers are paused.
  timer = window.setTimeout(disarmExit, EXIT_WINDOW_MS);
  if (typeof navigator.vibrate === "function") navigator.vibrate(10);
  return false;
}
