import { useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

// Checkpoints are per tab and exist only for a controlled screen replacement.
// IndexedDB accommodates image drafts without localStorage's small string quota.
const marker = "palmagent:screen-checkpoint";
const storeName = "checkpoints";
type Screen = { scroll: { top: number; left: number }[]; focus?: { index: number; start: number | null; end: number | null } };
type Checkpoint = { route: string; created: number; values: Record<string, unknown>; screen: Screen };
const scrollSelector = '[data-radix-scroll-area-viewport]:not([aria-label="Session transcript"]), [data-slot="settings-scroll"]';
const editSelector = 'input:not([type="hidden"]):not([type="file"]):not([type="password"]), textarea';
let restoredScreen: Screen | undefined;
function captureScreen(): Screen {
  const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(editSelector)];
  const index = fields.findIndex((field) => field === document.activeElement);
  return {
    scroll: [...document.querySelectorAll<HTMLElement>(scrollSelector)].map((el) => ({ top: el.scrollTop, left: el.scrollLeft })),
    ...(index < 0 ? {} : { focus: { index, start: fields[index].selectionStart, end: fields[index].selectionEnd } }),
  };
}
export function restoreScreenPosition() {
  const screen = restoredScreen;
  if (!screen) return;
  let frame = 0;
  const observer = new MutationObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(restore); });
  const interactions = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
  const stop = () => {
    observer.disconnect(); cancelAnimationFrame(frame); clearTimeout(timeout);
    for (const event of interactions) window.removeEventListener(event, stop, true);
  };
  const timeout = setTimeout(stop, 8000);
  function restore() {
    const scroll = [...document.querySelectorAll<HTMLElement>(scrollSelector)];
    screen!.scroll.forEach((saved, index) => { if (scroll[index]) { scroll[index].scrollTop = saved.top; scroll[index].scrollLeft = saved.left; } });
    if (screen!.focus) {
      const field = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(editSelector)[screen!.focus.index];
      if (field?.getClientRects().length) {
        field.focus({ preventScroll: true });
        try { field.setSelectionRange(screen!.focus.start, screen!.focus.end); } catch { /* non-text inputs have no selection */ }
        screen!.focus = undefined;
      }
    }
  }
  observer.observe(document.getElementById("root")!, { childList: true, subtree: true });
  for (const event of interactions) window.addEventListener(event, stop, { capture: true, passive: true });
  frame = requestAnimationFrame(restore);
}
const values = new Map<string, () => unknown>();
let restored: Record<string, unknown> = {};
let revision = 0;
let work = 0;
const listeners = new Set<() => void>();
export const onBrowserStateChange = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function browserStateChanged() { revision++; listeners.forEach((listener) => listener()); }
export const browserWorkPending = () => work > 0;
export function beginBrowserWork(): () => void {
  work++; browserStateChanged();
  let done = false;
  return () => { if (!done) { done = true; work--; browserStateChanged(); } };
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("palmagent-screen-state", 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Draft storage is busy"));
  });
}
async function transaction<T>(operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const request = operation(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(tx.error ?? request.error ?? new Error("Could not save browser state"));
    });
  } finally { db.close(); }
}

export async function restoreUpdateState(): Promise<void> {
  let id: string | null;
  try { id = sessionStorage.getItem(marker); } catch { return; }
  if (!id) return;
  const checkpoint = await transaction((store) => store.get(id)) as Checkpoint | undefined;
  if (checkpoint && checkpoint.route === location.hash && Date.now() - checkpoint.created < 24 * 60 * 60_000) {
    restored = checkpoint.values;
    restoredScreen = checkpoint.screen;
  }
  // Consume only after a successful read. A failed restore can be retried.
  sessionStorage.removeItem(marker);
  void transaction((store) => store.delete(id!)).catch(() => {});
}
export async function checkpointBrowserState(): Promise<boolean> {
  const before = revision;
  const checkpoint: Checkpoint = { route: location.hash, created: Date.now(), values: { ...restored, ...Object.fromEntries([...values].map(([key, read]) => [key, read()])) }, screen: captureScreen() };
  const id = crypto.randomUUID();
  await transaction((store) => store.put(checkpoint, id));
  if (before !== revision || browserWorkPending()) {
    await transaction((store) => store.delete(id));
    return false;
  }
  try {
    const old = sessionStorage.getItem(marker);
    sessionStorage.setItem(marker, id);
    if (old) void transaction((store) => store.delete(old)).catch(() => {});
  }
  catch (error) { await transaction((store) => store.delete(id)); throw error; }
  return true;
}
export function useUpdateState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => Object.hasOwn(restored, key) ? restored[key] as T : typeof initial === "function" ? (initial as () => T)() : initial);
  const current = useRef(value);
  useLayoutEffect(() => {
    current.current = value;
    browserStateChanged();
  }, [value]);
  useLayoutEffect(() => {
    const read = () => current.current;
    values.set(key, read);
    delete restored[key];
    return () => { if (values.get(key) === read) values.delete(key); };
  }, [key]);
  return [value, setValue];
}
export function useUpdateBlocker(blocked: boolean) {
  useLayoutEffect(() => blocked ? beginBrowserWork() : undefined, [blocked]);
}

export function readUpdateSnapshot<T>(key: string): T | undefined { return restored[key] as T | undefined; }
export function useUpdateSnapshot(key: string, read: () => unknown) {
  const current = useRef(read);
  current.current = read;
  useLayoutEffect(() => {
    const reader = () => current.current();
    values.set(key, reader);
    delete restored[key];
    return () => { if (values.get(key) === reader) values.delete(key); };
  }, [key]);
}
