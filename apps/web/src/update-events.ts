const events = new EventTarget();
export function updatesChanged(): void { events.dispatchEvent(new Event("change")); }
export function onUpdatesChanged(listener: () => void): () => void {
  events.addEventListener("change", listener);
  return () => events.removeEventListener("change", listener);
}
