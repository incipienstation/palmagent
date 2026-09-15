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
let progressTimer: ReturnType<typeof setTimeout> | undefined;
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

function pauseUpdate() {
  applying = false; failed = true;
  clearTimeout(activationTimer); clearTimeout(progressTimer); progressTimer = undefined;
  coordinateStreams(false); emit();
}
function watchProgress() {
  if (!needsUpdate() || failed || progressTimer) return;
  // Bound discovery and installation; saves and activation have their own deadlines.
  // This is a transition deadline, not a periodic release check.
  progressTimer = setTimeout(() => {
    progressTimer = undefined;
    // Intentional deferral is resumed by the next browser-state event.
    if (registration?.waiting || activated || composing || browserWorkPending() || hidden() || !navigator.onLine) return;
    pauseUpdate();
  }, 30_000);
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Screen update timed out")), 10_000);
    })]);
  } finally { clearTimeout(timeout); }
}

async function reconcileController() {
  const worker = navigator.serviceWorker.controller;
  if (!worker || !serverVersion || activated) return;
  const version = await new Promise<string | undefined>((resolve) => {
    const port = new MessageChannel();
    const finish = (value?: string) => { clearTimeout(timeout); port.port1.close(); port.port2.close(); resolve(value); };
    const timeout = setTimeout(() => finish(), 2_000);
    port.port1.onmessage = (event) => finish(typeof event.data?.version === "string" ? event.data.version : undefined);
    try { worker.postMessage({ type: "PALMAGENT_VERSION" }, [port.port2]); }
    catch { finish(); }
  });
  // A mobile tab can miss controllerchange while suspended. Only reload when
  // its controlling worker proves it has the requested screen, never the old one.
  if (worker === navigator.serviceWorker.controller && version === serverVersion && version !== clientVersion) {
    activated = true; schedule();
  }
}

// Each tab checkpoints its own state, even if another tab activates the worker.
// Native registration avoids a library listener reloading before our checkpoint.
function schedule() {
  if (!ready || !needsUpdate()) return;
  watchProgress();
  emit();
  clearTimeout(timer);
  timer = setTimeout(() => { void transition(); }, 750);
}
async function transition() {
  if (failed || processing || applying || composing || browserWorkPending() || hidden() || !navigator.onLine) return;
  if (!activated && !registration?.waiting) return; // discovery is bounded by watchProgress
  processing = true;
  try {
    failed = false;
    if (!await bounded(checkpointBrowserState())) { schedule(); return; }
    // Input or a mutation may have started during the asynchronous checkpoint.
    if (failed || !needsUpdate() || composing || browserWorkPending() || hidden() || !navigator.onLine) return;
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
    activationTimer = setTimeout(pauseUpdate, 10_000);
  } catch {
    pauseUpdate();
  } finally { processing = false; }
}

function observeRegistration(value: ServiceWorkerRegistration) {
  registration = value;
  if (value.waiting) failed = false;
  const installing = () => {
    const worker = value.installing;
    worker?.addEventListener("statechange", () => {
      if (worker.state === "installed") { failed = false; setTimeout(schedule, 0); }
      if (worker.state === "redundant") pauseUpdate();
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
    if (controlled || serverVersion || applying) { activated = true; applying = false; failed = false; clearTimeout(activationTimer); coordinateStreams(false); schedule(); }
    controlled = true;
    emit();
  });
  void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then(observeRegistration).catch(() => { failed = true; emit(); });
}
export function checkPwaUpdate(): Promise<void> {
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return Promise.resolve();
  if (checking) return checking;
  failed = false; watchProgress();
  checking = bounded((async () => {
    const value = await navigator.serviceWorker.getRegistration()
      ?? await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
    if (!value) throw new Error("Service worker registration is unavailable");
    if (registration !== value) observeRegistration(value);
    // Reconcile before update(), which can stall on an unavailable network.
    await reconcileController();
    await value.update();
    schedule();
  })()).catch(pauseUpdate).finally(() => { checking = undefined; });
  return checking;
}
export function observeServerVersion(version?: string | null): void {
  if (!version) return;
  if (version === clientVersion) {
    if (!serverVersion) return;
    serverVersion = undefined;
    if (!needsUpdate()) {
      failed = false; applying = false;
      clearTimeout(timer); clearTimeout(progressTimer); progressTimer = undefined;
      clearTimeout(activationTimer); coordinateStreams(false);
    }
    emit(); return;
  }
  if (version === serverVersion) return;
  serverVersion = version;
  watchProgress(); emit(); void checkPwaUpdate();
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
