import { pauseStreams } from "./stream-transition";
import { useSyncExternalStore } from "react";
import { browserStateChanged, browserWorkPending, checkpointBrowserState, onBrowserStateChange } from "./update-state";

declare const __PALMAGENT_WEB_VERSION__: string;
export const clientVersion = __PALMAGENT_WEB_VERSION__;
let serverVersion: string | undefined;
let registration: ServiceWorkerRegistration | undefined;
let checking: Promise<void> | undefined;
let controlled = false;
let activated = false;
let applying = false;
let failed = false;
let composing = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let activationTimer: ReturnType<typeof setTimeout> | undefined;
let processing = false;
let ready = false;
let channel: BroadcastChannel | undefined;
function coordinateStreams(paused: boolean) {
  pauseStreams(paused);
  channel?.postMessage({ paused });
}
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const hidden = () => document.visibilityState === "hidden";
const needsUpdate = () => activated || (controlled && Boolean(registration?.waiting)) || Boolean(serverVersion);

// Each tab checkpoints its own state, even if another tab activates the worker.
// Native registration avoids a library listener reloading before our checkpoint.
function schedule() {
  if (!ready || !needsUpdate()) return;
  emit();
  clearTimeout(timer);
  timer = setTimeout(() => { void transition(); }, 750);
}
async function transition() {
  if (processing || applying || composing || browserWorkPending() || hidden() || !navigator.onLine) return;
  if (!activated && !registration?.waiting) return; // wait for a fully installed screen
  processing = true;
  try {
    failed = false;
    if (!await checkpointBrowserState()) { schedule(); return; }
    // Input or a mutation may have started during the asynchronous checkpoint.
    if (composing || browserWorkPending() || hidden() || !navigator.onLine) return;
    if (activated) {
      applying = true; emit();
      window.location.reload();
      return;
    }
    applying = true; emit();
    coordinateStreams(true);
    registration?.waiting?.postMessage({ type: "SKIP_WAITING" });
    // A timeout reports a recoverable error; it never reloads an old shell.
    clearTimeout(timer);
    activationTimer = setTimeout(() => { applying = false; failed = true; coordinateStreams(false); emit(); }, 10_000);
  } catch {
    applying = false; failed = true; coordinateStreams(false); emit();
  } finally { processing = false; }
}

function observeRegistration(value: ServiceWorkerRegistration) {
  registration = value;
  const installing = () => {
    const worker = value.installing;
    worker?.addEventListener("statechange", () => {
      if (worker.state === "installed") setTimeout(schedule, 0);
      if (worker.state === "redundant") { failed = true; emit(); }
    });
  };
  value.addEventListener("updatefound", installing);
  installing(); schedule();
}
export function startPwaUpdates() {
  ready = true;
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel("palmagent-screen-transition");
    let lease: ReturnType<typeof setTimeout> | undefined;
    channel.onmessage = (event) => {
      if (typeof event.data?.paused !== "boolean") return;
      clearTimeout(lease);
      pauseStreams(event.data.paused);
      // A closing initiating tab cannot leave another tab disconnected.
      if (event.data.paused) lease = setTimeout(() => pauseStreams(false), 10_000);
    };
  }
  onBrowserStateChange(schedule);
  for (const event of ["input", "pointerdown", "keydown", "wheel", "touchmove", "focusout", "hashchange"]) window.addEventListener(event, browserStateChanged, true);
  window.addEventListener("compositionstart", () => { composing = true; browserStateChanged(); });
  window.addEventListener("compositionend", () => { composing = false; browserStateChanged(); });
  window.addEventListener("online", () => { void checkPwaUpdate(); schedule(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { void checkPwaUpdate(); schedule(); } });
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;
  controlled = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (controlled || serverVersion || applying) { activated = true; applying = false; clearTimeout(activationTimer); coordinateStreams(false); schedule(); }
    controlled = true;
    emit();
  });
  void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then(observeRegistration).catch(() => { failed = true; emit(); });
}
export function checkPwaUpdate(): Promise<void> {
  if (!("serviceWorker" in navigator)) return Promise.resolve();
  return checking ??= navigator.serviceWorker.getRegistration().then(async (value) => {
    if (value) { registration ??= value; await value.update(); schedule(); }
  }).catch(() => { failed = true; emit(); }).finally(() => { checking = undefined; });
}
export function observeServerVersion(version?: string | null): void {
  if (!version || version === clientVersion || version === serverVersion) return;
  serverVersion = version;
  emit(); void checkPwaUpdate();
}
export function retryUpdate() { applying = false; clearTimeout(activationTimer); failed = false; emit(); void checkPwaUpdate(); schedule(); }

/** An explicit pull-to-refresh still works, without an update confirmation step. */
export function reloadApp(): void {
  if (needsUpdate()) { retryUpdate(); return; }
  window.location.reload();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function usePwaUpdate() { return useSyncExternalStore(subscribe, needsUpdate, () => false); }
export function usePwaApplying() { return useSyncExternalStore(subscribe, () => applying, () => false); }
export function usePwaFailure() { return useSyncExternalStore(subscribe, () => failed, () => false); }
