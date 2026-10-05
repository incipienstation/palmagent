import { QueryClient, type QueryKey } from "@tanstack/react-query";
import { clientReadKeys } from "./client-query-keys";
import { onCacheSessionReset, onClientReadInvalidation } from "./query-lifecycle";

// Keep TanStack's normal per-query freshness defaults. Resource-specific cache
// policy lives beside each key/queryFn, so transcript rules cannot leak into
// ordinary reads.
export const queryClient = new QueryClient();

onCacheSessionReset(() => queryClient.clear());

const pendingRefreshes = new WeakMap<object, Promise<void>>();

// A read already in flight can predate a stream notification. Let it settle,
// then read again; cancelRefetch:false alone would swallow that notification.
// Coalesce bursts during each request, including the initial load, without
// continually aborting slow reads. Removed/session-cleared queries stay gone.
export async function refreshClientReads(queryKey: QueryKey): Promise<void> {
  await Promise.all(queryClient.getQueryCache().findAll({ queryKey }).map(query => {
    query.invalidate();
    if (query.state.fetchStatus === "idle") {
      return queryClient.refetchQueries({ queryKey: query.queryKey, exact: true, type: "active" });
    }
    const pending = pendingRefreshes.get(query);
    if (pending) return pending;
    const refresh = (async () => {
      await query.promise?.catch(() => {});
      // Release before starting the follow-up so changes during that request
      // can schedule another read of their own.
      pendingRefreshes.delete(query);
      if (queryClient.getQueryCache().get(query.queryHash) !== query) return;
      await queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true, refetchType: "active" }, { cancelRefetch: false });
    })();
    pendingRefreshes.set(query, refresh);
    return refresh;
  }));
}

onClientReadInvalidation((source, scopes) => {
  const queryKeys: QueryKey[] = scopes.map((scope): QueryKey => {
    switch (scope) {
      case "agents": return clientReadKeys.agents();
      case "repos": return clientReadKeys.repos();
      case "modelCatalog": return clientReadKeys.modelCatalog();
      case "usage": return clientReadKeys.usage();
      case "routines": return clientReadKeys.routines();
      case "routineRuns": return clientReadKeys.routineRunsAll();
      case "skills": return [...clientReadKeys.all, "skills"];
    }
  });
  // Cancel in-flight reads before a write so a late response cannot overwrite a
  // mutation result. Foreground and cross-tab invalidations also refresh active
  // reads; local writes only mark them stale until their mutation reconciles.
  return (async () => {
    await Promise.all(queryKeys.map((queryKey) => queryClient.cancelQueries({ queryKey })));
    await Promise.all(queryKeys.map((queryKey) => queryClient.invalidateQueries({
      queryKey,
      refetchType: source === "mutation" ? "none" : "active",
    })));
  })();
});
