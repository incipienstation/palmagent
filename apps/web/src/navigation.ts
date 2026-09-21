import { flushSync } from "react-dom";
import { disarmExit, isStandalone, showExitHint } from "./backGuard";

// One temporary entry covers the visible layer stack. Nested Back dismisses one
// layer and re-covers the page; ordinary close removes the entry before routing.
// Only page entries survive navigation. Forward never replays a dismissed action.
type Entry = { version: 1; session: string; index: number; depth: number; hash: string; kind: "page" | "layer" | "floor" };
type Layer = { dismiss: () => void; priority: number; order: number };
type Destination = { hash: string; replace?: boolean };
const key = "__palmagentNavigation";
const layers = new Set<Layer>();
const listeners = new Set<() => void>();
let current: Entry;
let visibleHash = "#/";
let standalone = false;
let ready: Promise<void> | undefined;
let finishBoot: (() => void) | undefined;
let traversing = false;
let cleanup: -1 | 0 | 1 = 0;
let lastIndex = 0;
const endKey = "palmagent:navigation-end";
let scheduled = false;
let order = 0;
let destination: Destination | undefined;
const hash = () => location.hash || "#/";

function readEntry(): Entry | undefined {
  const entry = history.state?.[key] as Entry | undefined;
  return entry?.version === 1 && typeof entry.session === "string" && Number.isInteger(entry.index)
    && Number.isInteger(entry.depth) && entry.hash === hash()
    && ["page", "layer", "floor"].includes(entry.kind) ? entry : undefined;
}
function write(entry: Entry, replace = false) {
  current = entry;
  const state = { [key]: entry, ...(standalone && entry.depth === 0 && entry.kind !== "layer"
    ? { __backGuard: entry.kind === "floor" ? "floor" : "app" } : {}) };
  // Keep a hashless root byte-identical when only stamping metadata: older
  // update checkpoints match their saved URL before restoring drafts/settings.
  const url = replace && entry.hash === hash() ? location.href : entry.hash;
  history[replace ? "replaceState" : "pushState"](state, "", url);
  lastIndex = replace ? Math.max(lastIndex, entry.index) : entry.index;
  try { sessionStorage.setItem(endKey, JSON.stringify({ session: entry.session, index: lastIndex })); } catch { /* optional across reloads */ }
}
function publish() {
  if (visibleHash === current.hash) return;
  visibleHash = current.hash;
  listeners.forEach(listener => listener());
  // PWA checkpoint invalidation also observes hash changes made with pushState.
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}
function topLayer() {
  return [...layers].sort((a, b) => b.priority - a.priority || b.order - a.order)[0];
}
function dismissAll() {
  flushSync(() => [...layers].sort((a, b) => b.priority - a.priority || b.order - a.order).forEach(layer => layer.dismiss()));
}
function removeCover(direction: -1 | 1 = -1) {
  cleanup = direction;
  traversing = true;
  history.go(direction);
}
function schedule() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => { scheduled = false; reconcile(); });
}
function restoreRootGuard() {
  if (current.kind !== "floor" || traversing) return;
  disarmExit();
  // Reuse the existing root entry. Pushing from popstate can make Chromium skip
  // every same-document entry on the next system Back, even after hint expiry.
  removeCover(1);
}
function reconcile() {
  if (!current || traversing) return;
  if (current.kind === "floor" && (destination || layers.size)) {
    restoreRootGuard();
    return;
  }
  if (destination) {
    if (layers.size) dismissAll();
    // A saving dialog may refuse dismissal. Keep the user's work on screen.
    if (layers.size) { destination = undefined; return; }
    if (current.kind === "layer") { removeCover(); return; }
    const next = destination;
    destination = undefined;
    disarmExit();
    if (next.hash !== current.hash) {
      write({ ...current, kind: "page", hash: next.hash,
        index: current.index + (next.replace ? 0 : 1), depth: current.depth + (next.replace ? 0 : 1) }, next.replace);
      publish();
    }
    return;
  }
  if (layers.size && current.kind === "page") {
    disarmExit();
    write({ ...current, kind: "layer", index: current.index + 1 });
  } else if (!layers.size && current.kind === "layer") {
    removeCover();
  }
}
function onPopState() {
  const previous = current;
  const cleaning = cleanup;
  cleanup = 0;
  traversing = false;
  current = readEntry() ?? { ...previous, kind: "page", hash: hash(), index: previous.index + 1, depth: previous.depth + 1 };
  if (!readEntry()) write(current, true); // Adopt native hash links (including notification navigation).
  if (cleaning) {
    if (current.kind === "layer") { removeCover(cleaning === 1 && current.index < lastIndex ? 1 : -1); return; }
    publish();
    finishBoot?.(); finishBoot = undefined;
    schedule();
    return;
  }
  destination = undefined;
  if (previous.kind === "layer" && current.kind === "page" && previous.session === current.session
    && previous.index === current.index + 1 && previous.hash === current.hash) {
    const top = topLayer();
    if (top) flushSync(() => top.dismiss());
    // Refused dismissals and remaining nested layers receive a new cover.
    reconcile();
    return;
  }
  if (current.kind === "layer") {
    // A closed overlay can remain as the browser's final Forward entry. Skip it
    // rather than resurrecting a dialog or adding a dead Back press after reload.
    const forward = current.session === previous.session && current.index > previous.index;
    removeCover(forward && current.index < lastIndex ? 1 : -1);
    return;
  }
  dismissAll();
  if (standalone && current.kind === "floor") {
    // Leave the first entry exposed for the *next native* Back. JavaScript
    // history.back() cannot close a PWA at the start of history; waiting for its
    // nonexistent popstate would permanently block subsequent app navigation.
    showExitHint(restoreRootGuard);
    publish();
    return;
  }
  disarmExit();
  publish();
  schedule();
}

export function setupNavigation(): Promise<void> {
  if (ready) return ready;
  standalone = isStandalone();
  const saved = readEntry();
  const initialHash = hash();
  current = saved ?? { version: 1, session: crypto.randomUUID(), index: 0, depth: 0, hash: initialHash, kind: "page" };
  lastIndex = current.index;
  try {
    const end = JSON.parse(sessionStorage.getItem(endKey) ?? "null");
    if (end?.session === current.session && Number.isInteger(end.index)) lastIndex = Math.max(lastIndex, end.index);
  } catch { /* history still works when storage is unavailable */ }
  if (!saved) {
    if (standalone) {
      write({ ...current, hash: "#/", kind: "floor" }, true);
      write({ ...current, kind: "page", index: 1 });
      if (initialHash !== "#/") write({ ...current, hash: initialHash, index: 2, depth: 1 });
    } else write(current, true);
  }
  if (current.kind === "floor") write({ ...current, kind: "page", index: current.index + 1 });
  visibleHash = current.hash;
  window.addEventListener("popstate", onPopState);
  window.addEventListener("hashchange", () => {
    // popstate usually adopts native hash navigation first; this also supports
    // external replaceState callers that explicitly emit hashchange.
    if (!traversing && hash() !== current.hash) onPopState();
  });
  ready = new Promise(resolve => {
    if (current.kind === "layer") { finishBoot = resolve; removeCover(); }
    else resolve();
  });
  return ready;
}
export function registerBackLayer(dismiss: () => void, priority: number): () => void {
  const layer = { dismiss, priority, order: ++order };
  layers.add(layer);
  schedule();
  return () => { layers.delete(layer); schedule(); };
}
export const subscribeNavigation = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const navigationHash = () => visibleHash;
export function navigate(path: string, opts?: { replace?: boolean }) {
  destination = { hash: path.startsWith("#") ? path : `#${path}`, replace: opts?.replace };
  schedule();
}
export function goBack() {
  if (traversing) return;
  if (layers.size) {
    // Opening and backing out in one event turn must still dismiss the layer.
    if (current.kind !== "layer") { const top = topLayer(); if (top) flushSync(() => top.dismiss()); return; }
  } else if (current.depth === 0) {
    // An in-app arrow always stays in Palmagent, even on a browser deep link.
    if (current.hash !== "#/") navigate("/", { replace: true });
    return;
  }
  traversing = true;
  history.back();
}
