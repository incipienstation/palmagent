import { useSyncExternalStore } from "react";
import { registerSW } from "virtual:pwa-register";

// Deploy-update UX. The PWA is OFF silent auto-reload (which would wipe an
// in-progress dispatch/steer draft) and ON an in-app prompt instead: with
// registerType "prompt", a freshly deployed service worker installs and *waits*.
// This module surfaces that as `usePwaUpdate()` (drives the UpdateBanner) and
// only activates + reloads when the user taps Refresh. Drafts are additionally
// persisted (useDraft) so the reload is always safe.

let waiting = false; // a new SW is installed and waiting to take over
let dismissed = false; // user dismissed the banner for the current update
let applying = false; // user tapped Refresh — activation in progress
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

// registerSW drives the workbox-window update lifecycle and returns updateSW —
// the canonical way to activate a waiting SW. In dev the SW is disabled
// (vite.config devOptions), so onNeedRefresh never fires and the banner stays
// hidden. updateSW(true) posts SKIP_WAITING to the waiting SW via workbox-window.
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    waiting = true;
    dismissed = false; // a new deploy re-nudges even if a prior one was dismissed
    applying = false; // reset stuck "Updating…" if a newer deploy arrives
    emit();
  },
});

/** Activate the waiting service worker and reload onto the new version. */
export function applyUpdate(): void {
  applying = true;
  emit();
  // Hard fallback: if the SW update mechanism doesn't trigger a controllerchange
  // within 3 s (e.g. waiting SW became redundant, clients.claim() race, etc.)
  // force a plain reload anyway so the button is never a no-op.
  const fallback = setTimeout(() => window.location.reload(), 3000);

  // workbox-window's 'controlling' event only reloads when isUpdate=true, which is
  // set once at registration time as Boolean(navigator.serviceWorker.controller).
  // On first-install the page loads without a controller so _isUpdate=false, and
  // later updates never trigger a reload through workbox. Listen to the browser's
  // own controllerchange instead — it fires unconditionally when the new SW takes
  // over, regardless of whether there was a prior controller.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => {
        clearTimeout(fallback);
        window.location.reload();
      },
      { once: true },
    );
  }
  void updateSW(true);
}

/** Hide the banner until the next deploy. */
export function dismissUpdate(): void {
  dismissed = true;
  emit();
}

/**
 * Manual refresh (pull-to-refresh). If a deployed update is waiting, activate
 * it and reload onto the new version; otherwise a plain reload.
 */
export function reloadApp(): void {
  if (waiting) {
    applyUpdate();
  } else {
    window.location.reload();
  }
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};
const shouldShow = () => waiting && !dismissed;
const getApplying = () => applying;

/** True when a deployed update is waiting and the user hasn't dismissed it. */
export function usePwaUpdate(): boolean {
  return useSyncExternalStore(subscribe, shouldShow, () => false);
}

/** True while the Refresh tap is in-flight (SKIP_WAITING sent, waiting for reload). */
export function usePwaApplying(): boolean {
  return useSyncExternalStore(subscribe, getApplying, () => false);
}
