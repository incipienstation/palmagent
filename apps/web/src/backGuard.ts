import { toast } from "./components/ui/toaster";

const EXIT_WINDOW_MS = 2000;
let armedUntil = 0;
export function isStandalone(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches
    || (navigator as { standalone?: boolean }).standalone === true;
}
export function disarmExit(): void { armedUntil = 0; }
// Called only after navigating onto the single root floor. Reloads retain that
// floor, and deep links have a real inbox entry above it before their task page.
export function shouldExit(): boolean {
  if (Date.now() < armedUntil) { disarmExit(); return true; }
  armedUntil = Date.now() + EXIT_WINDOW_MS;
  if (typeof navigator.vibrate === "function") navigator.vibrate(10);
  toast({ description: "Press back again to exit", variant: "info", duration: EXIT_WINDOW_MS });
  return false;
}
