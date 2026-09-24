import { useSyncExternalStore } from "react";
import type { Repo } from "@palmagent/shared";
import { api } from "./api";
import { cacheSession, onCacheSessionReset } from "./query-lifecycle";
import { clientReadKeys } from "./client-query-keys";
import { reposQueryOptions } from "./client-queries";
import { queryClient } from "./query-client";
import { toast } from "./components/ui/toaster";
let snapshot = { removed: new Set<string>(), removing: new Set<string>(), registering: new Set<string>() };
const listeners = new Set<() => void>();
function publish() { snapshot = { removed: new Set(snapshot.removed), removing: new Set(snapshot.removing), registering: new Set(snapshot.registering) }; listeners.forEach(fn => fn()); }
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const useRepoMutations = () => useSyncExternalStore(subscribe, () => snapshot);
export async function registerRepo(path: string): Promise<Repo | undefined> {
  if (snapshot.registering.has(path)) return;
  const generation = cacheSession();
  snapshot.registering.add(path); publish();
  try {
    const actual = await api.createRepo({ path });
    if (generation === cacheSession()) {
      snapshot.removed.delete(actual.id);
      queryClient.setQueryData<Repo[]>(clientReadKeys.repos(), (current) => current
        ? [...current.filter((repo) => repo.id !== actual.id), actual] : [actual]);
    }
    return actual;
  }
  finally { if (generation === cacheSession()) { snapshot.registering.delete(path); publish(); } }
}
export async function removeRepo(repo: Repo) {
  if (snapshot.removing.has(repo.id) || snapshot.removed.has(repo.id)) return;
  const generation = cacheSession();
  snapshot.removing.add(repo.id); snapshot.removed.add(repo.id); publish();
  try {
    await api.deleteRepo(repo.id);
    if (generation === cacheSession()) queryClient.setQueryData<Repo[]>(clientReadKeys.repos(), (current) => current?.filter((item) => item.id !== repo.id));
  }
  catch (error) {
    if (generation !== cacheSession()) return;
    snapshot.removed.delete(repo.id); publish();
    toast({ title: "Couldn't remove repository", description: error instanceof Error ? error.message : "Try again.", variant: "destructive" });
    try {
      const actual = await queryClient.fetchQuery({ ...reposQueryOptions(), staleTime: 0 });
      if (generation === cacheSession()) {
        queryClient.setQueryData(clientReadKeys.repos(), actual);
        if (!actual.some((item) => item.id === repo.id)) snapshot.removed.add(repo.id);
      }
    }
    catch { /* Preserve the confirmed row when reconciliation is unavailable. */ }
  } finally { if (generation === cacheSession()) { snapshot.removing.delete(repo.id); publish(); } }
}
onCacheSessionReset(() => { snapshot = { removed: new Set(), removing: new Set(), registering: new Set() }; publish(); });
