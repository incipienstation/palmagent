export type ClientReadInvalidationSource = "mutation" | "remote" | "foreground";
export type ClientReadScope = "repos" | "modelCatalog" | "usage" | "routines" | "routineRuns" | "skills";

let sessionGeneration = 0;
const resetListeners = new Set<() => void>();
const invalidationListeners = new Set<(source: ClientReadInvalidationSource, scopes: readonly ClientReadScope[]) => void | Promise<void>>();
export const cacheSession = () => sessionGeneration;

export function onCacheSessionReset(listener: () => void): void { resetListeners.add(listener); }
export function onClientReadInvalidation(listener: (source: ClientReadInvalidationSource, scopes: readonly ClientReadScope[]) => void | Promise<void>): void {
  invalidationListeners.add(listener);
}

export function resetClientSession(): void {
  sessionGeneration++;
  for (const listener of resetListeners) listener();
}

function notifyReadsInvalidated(source: ClientReadInvalidationSource, scopes: readonly ClientReadScope[]): Promise<void> {
  if (scopes.length === 0) return Promise.resolve();
  return Promise.all([...invalidationListeners].map((listener) => listener(source, scopes))).then(() => undefined);
}

// Other tabs share cookies and mutations, but never response bodies.
const channel = typeof window !== "undefined" && typeof BroadcastChannel !== "undefined"
  ? new BroadcastChannel("palmagent-cache") : undefined;
channel?.addEventListener("message", ({ data }) => {
  if (data === "session") resetClientSession();
  else if (data === "invalidate") {
    void notifyReadsInvalidated("remote", ["repos", "modelCatalog", "usage", "routines", "routineRuns", "skills"]).catch(() => {});
  }
  else if (data && typeof data === "object" && data.type === "invalidate" && Array.isArray(data.scopes)) {
    void notifyReadsInvalidated("remote", data.scopes.filter((scope: unknown): scope is ClientReadScope =>
      typeof scope === "string" && ["repos", "modelCatalog", "usage", "routines", "routineRuns", "skills"].includes(scope))).catch(() => {});
  }
});

export function invalidateClientReads(session = false, scopes?: readonly ClientReadScope[]): Promise<void> {
  if (session) {
    resetClientSession();
    channel?.postMessage("session");
    return Promise.resolve();
  } else {
    const affected = scopes ?? ["repos", "modelCatalog", "usage", "routines", "routineRuns", "skills"];
    if (affected.length === 0) return Promise.resolve();
    const settled = notifyReadsInvalidated("mutation", affected);
    channel?.postMessage({ type: "invalidate", scopes: affected });
    return settled;
  }
}

if (typeof window !== "undefined") {
  const refresh = () => {
    // The inbox stream refreshes these three reads after its new snapshot lands.
    void notifyReadsInvalidated("foreground", ["repos", "modelCatalog", "skills"]).catch(() => {});
  };
  window.addEventListener("online", refresh);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
}
