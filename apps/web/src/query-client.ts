import { QueryClient, type QueryKey } from "@tanstack/react-query";
import { clientReadKeys } from "./client-query-keys";
import { onCacheSessionReset, onClientReadInvalidation } from "./query-lifecycle";

// Keep TanStack's normal per-query freshness defaults. Resource-specific cache
// policy lives beside each key/queryFn, so transcript rules cannot leak into
// ordinary reads.
export const queryClient = new QueryClient();

onCacheSessionReset(() => queryClient.clear());

onClientReadInvalidation((source, scopes) => {
  const queryKeys: QueryKey[] = scopes.map((scope): QueryKey => {
    switch (scope) {
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
