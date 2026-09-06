// Root back-button guard for the installed (standalone) PWA — double-back-to-exit.
//
// In an installed Android PWA the system Back button, pressed at the app's root,
// closes the whole app in one tap — easy to hit by accident. We can't cancel a
// browser back, so instead we lay one marker entry ("floor") at the very bottom
// of the app's history and watch for a back that lands on it:
//
//   [floor] [app] [task] …            ← the app pushes real entries above the floor
//    ^ marked with history.state.__backGuard === "floor"
//
// A back that pops onto the floor is the one that WOULD exit. The first such back
// is absorbed (we re-cover the floor with a fresh entry, warn via toast, and arm a
// short window); a second back inside that window is let through — we call
// history.back() to pop below the floor and actually leave. In-app backs (e.g.
// task→inbox) land on router entries (state === null), never the floor, so they
// pass through untouched: the guard only ever engages at the true bottom.
//
// Gated to display-mode: standalone — a plain browser tab keeps native back, and
// on iOS an installed PWA has no system back button at all (the gate simply no-ops
// there). Modelled on the imperative viewport.ts/pwa.ts wiring (called once from
// main.tsx), so React/StrictMode never double-installs the history entries.

import { toast } from "./components/ui/toaster";

type GuardState = { __backGuard: "floor" | "app" };

// First back shows the hint + arms this window; a second back within it exits.
// Kept equal to the toast duration so the hint fades exactly as the window closes.
const EXIT_WINDOW_MS = 2000;

let installed = false;
let armed = false;
let timer: number | undefined;

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // iOS legacy standalone flag (non-standard; absent from lib.dom types).
    (navigator as { standalone?: boolean }).standalone === true
  );
}

function disarm(): void {
  armed = false;
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
}

function onPopState(e: PopStateEvent): void {
  // Only react to a back that lands on the floor sentinel. In-app backs land on
  // router entries (state === null) and are ignored, so navigation is unaffected.
  if ((e.state as GuardState | null)?.__backGuard !== "floor") return;

  if (armed) {
    // Second back within the window → let it through: pop below the floor to exit.
    disarm();
    history.back();
    return;
  }

  // First back → absorb it: re-cover the floor with a live entry, warn, arm.
  armed = true;
  history.pushState({ __backGuard: "app" } satisfies GuardState, "", location.hash || "#/");
  if (typeof navigator.vibrate === "function") navigator.vibrate(10);
  toast({ description: "Press back again to exit", variant: "info", duration: EXIT_WINDOW_MS });
  timer = window.setTimeout(disarm, EXIT_WINDOW_MS);
}

export function setupBackGuard(): void {
  if (installed || !isStandalone()) return;
  installed = true;
  // Mark the launch entry as the floor, then cover it with the live app entry so
  // the floor sits one below wherever the user is (URL unchanged → router intact).
  history.replaceState({ __backGuard: "floor" } satisfies GuardState, "");
  history.pushState({ __backGuard: "app" } satisfies GuardState, "", location.hash || "#/");
  window.addEventListener("popstate", onPopState);
}
