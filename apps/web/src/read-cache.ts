// Page-local reads: only explicitly selected endpoints opt in. Never persist
// authenticated responses in CacheStorage or reuse failures as successful data.
export class ReadCache {
  private entries = new Map<string, { expires: number; value: Promise<unknown> }>();
  constructor(private readonly limit = 50, private readonly now = Date.now) {}

  read<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing && existing.expires > this.now()) return existing.value as Promise<T>;
    const entry = { expires: Infinity, value: Promise.resolve().then(load) };
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    void entry.value.then(() => { entry.expires = this.now() + ttl; }, () => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return entry.value;
  }

  invalidate(matches: (key: string) => boolean = () => true): void {
    for (const key of this.entries.keys()) if (matches(key)) this.entries.delete(key);
  }
}

export const readCache = new ReadCache();
let sessionGeneration = 0;
const resetListeners = new Set<() => void>();
export const cacheSession = () => sessionGeneration;
export function onCacheSessionReset(listener: () => void): void { resetListeners.add(listener); }
export function resetClientSession(): void {
  sessionGeneration++;
  readCache.invalidate();
  for (const listener of resetListeners) listener();
}

// Other tabs share cookies and mutations, but never share response bodies.
const channel = typeof window !== "undefined" && typeof BroadcastChannel !== "undefined"
  ? new BroadcastChannel("palmagent-cache") : undefined;
channel?.addEventListener("message", ({ data }) => {
  if (data === "session") resetClientSession();
  else if (data === "invalidate") readCache.invalidate();
});
export function invalidateClientReads(session = false): void {
  if (session) resetClientSession();
  else readCache.invalidate();
  channel?.postMessage(session ? "session" : "invalidate");
}
if (typeof window !== "undefined") {
  window.addEventListener("online", () => readCache.invalidate());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") readCache.invalidate();
  });
}
