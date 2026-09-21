import { dismissToast, toast } from "./components/ui/toaster";

const EXIT_WINDOW_MS = 2000;
let hint: number | undefined;
let timer: number | undefined;
type NativeCloseWatcher = EventTarget & { destroy(): void };

// Android routes system Back to a close watcher before consulting session
// history. Its first watcher works without user activation, unlike pushState
// sentinels. Desktop browser Back is not a close request (Escape is).
export function watchNativeBack(onClose: () => void): (() => void) | undefined {
  const Constructor = (window as Window & { CloseWatcher?: new () => NativeCloseWatcher }).CloseWatcher;
  if (!isStandalone() || !/Android/i.test(navigator.userAgent) || typeof Constructor !== "function") return;
  const watcher = new Constructor();
  watcher.addEventListener("close", onClose, { once: true });
  return () => watcher.destroy();
}
export const hasExitHint = () => hint !== undefined;
export function isStandalone(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches
    || (navigator as { standalone?: boolean }).standalone === true;
}
export function disarmExit(): void {
  clearTimeout(timer);
  timer = undefined;
  const id = hint;
  hint = undefined;
  if (id !== undefined) dismissToast(id);
}
// Called only after navigating onto the single root floor. Reloads retain that
// floor, and deep links have a real inbox entry above it before their task page.
export function showExitHint(restoreGuard: () => void): void {
  disarmExit();
  const id = toast({ description: "Press back again to exit", variant: "info", duration: EXIT_WINDOW_MS,
    onClose: () => {
      if (hint !== id) return;
      hint = undefined;
      disarmExit();
      restoreGuard();
    },
  });
  hint = id;
  // Sonner pauses its own timer on hover/focus. The exit window is a fixed
  // deadline, so remove its hint even when ordinary toast timers are paused.
  timer = window.setTimeout(() => dismissToast(id), EXIT_WINDOW_MS);
  if (typeof navigator.vibrate === "function") navigator.vibrate(10);
}
