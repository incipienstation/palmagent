import { useEffect, useSyncExternalStore } from "react";
import type { RepoSettingsChange, RepoSettingsStatus } from "@palmagent/shared";
import { api } from "../api";
import { cacheSession, onCacheSessionReset } from "../read-cache";
import { toast } from "../components/ui/toaster";

let snapshot = { status: null as RepoSettingsStatus | null, busy: false, error: "", notice: "", adding: [] as string[] };
const listeners = new Set<() => void>();
const publish = (patch: Partial<typeof snapshot>) => { snapshot = { ...snapshot, ...patch }; listeners.forEach(fn => fn()); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
async function request(change?: RepoSettingsChange): Promise<boolean> {
  if (snapshot.busy) return false;
  const generation = cacheSession();
  const previous = snapshot.status;
  const projected = previous && change ? { ...previous,
    repoRoots: change.action === "remove" ? previous.repoRoots.filter(path => !change.paths.includes(path))
      : change.action === "reset" ? previous.defaults : previous.repoRoots,
    source: change.action === "reset" ? "installation" as const : change.action === "remove" ? "saved" as const : previous.source,
  } : previous;
  publish({ busy: true, status: projected, error: "", notice: "", adding: change?.action === "add" ? change.paths : [] });
  try {
    const next = change ? await api.repoSettings.change(change) : await api.repoSettings.get();
    if (generation !== cacheSession()) return false;
    publish({ status: next, notice: change ? change.action === "reset" ? "Installation defaults restored." : "Search paths saved." : "" });
    return true;
  } catch (cause) {
    if (generation !== cacheSession()) return false;
    const error = cause instanceof Error ? cause.message : "Could not load search paths.";
    publish({ status: change ? previous : null, adding: [], error });
    if (change) {
      toast({ title: "Couldn't save search paths", description: error, variant: "destructive" });
      try { const actual = await api.repoSettings.get(); if (generation === cacheSession()) publish({ status: actual }); }
      catch { if (generation === cacheSession()) publish({ status: null }); }
    }
    return false;
  } finally { if (generation === cacheSession()) publish({ busy: false, adding: [] }); }
}
onCacheSessionReset(() => publish({ status: null, busy: false, error: "", notice: "", adding: [] }));
export function useRepoSettings() {
  const state = useSyncExternalStore(subscribe, () => snapshot);
  useEffect(() => {
    void request();
    const refresh = () => { if (document.visibilityState === "visible") void request(); };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, []);
  return { ...state, request };
}
