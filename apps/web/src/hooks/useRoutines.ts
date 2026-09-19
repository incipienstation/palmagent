import { useSyncExternalStore } from "react";
import type { Routine } from "@palmagent/shared";
import { api, ApiError } from "../api";
import { cacheSession, onCacheSessionReset } from "../read-cache";
import { createOptimisticPreference } from "../optimistic-preference";
import { toast } from "../components/ui/toaster";

type Action = "run" | "delete";
let routines: Routine[] | null = null;
let version = 0;
const actions = new Map<string, Action>();
const preferences = new Map<string, ReturnType<typeof createOptimisticPreference<boolean>>>();
let creating: string | null = null;
let error = "";
const listeners = new Set<() => void>();
let snapshot = { routines, actions: new Map(actions), saving: new Set<string>(), stale: new Set<string>(), creating, error } as {
  routines: Routine[] | null; actions: Map<string, Action>; saving: Set<string>; stale: Set<string>; creating: string | null; error: string;
};
function publish() {
  snapshot = { routines: routines?.filter(r => actions.get(r.id) !== "delete").map(r => {
    const pref = preferences.get(r.id)?.get();
    return pref ? { ...r, enabled: pref.value, ...(pref.pending || pref.stale ? { nextRunAt: undefined } : {}) } : r;
  }) ?? null, actions: new Map(actions), saving: new Set([...preferences].filter(([, p]) => p.get().pending).map(([id]) => id)),
  stale: new Set([...preferences].filter(([, p]) => p.get().stale).map(([id]) => id)), creating, error };
  listeners.forEach(fn => fn());
}
function fail(cause: unknown) {
  error = cause instanceof Error ? cause.message : "Something went wrong.";
  toast({ title: "Couldn't update routines", description: error, variant: "destructive" });
}
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export async function reloadRoutines() {
  const at = version, generation = cacheSession();
  try {
    const next = await api.listRoutines();
    if (at !== version || generation !== cacheSession()) return;
    error = ""; routines = next;
    for (const r of next) preferences.get(r.id)?.observe(r.enabled);
    publish();
  } catch (cause) { if (generation === cacheSession()) { error = cause instanceof Error ? cause.message : "Could not load routines."; publish(); } }
}
function toggle(r: Routine) {
  if (actions.has(r.id)) return;
  let preference = preferences.get(r.id);
  if (!preference) {
    const generation = cacheSession();
    preference = createOptimisticPreference(r.enabled, {
      equal: (a, b) => a === b, changed: publish, failed: fail,
      save: async enabled => {
        const actual = await api.updateRoutine(r.id, { enabled });
        if (generation === cacheSession()) { version++; routines = routines?.map(item => item.id === r.id ? actual : item) ?? [actual]; }
        return actual.enabled;
      },
      recover: async () => {
        const next = await api.listRoutines();
        const actual = next.find(item => item.id === r.id);
        if (generation === cacheSession()) { version++; routines = routines?.flatMap(item => item.id === r.id ? actual ? [actual] : [] : [item]) ?? next; }
        if (!actual) throw new Error("This routine is no longer available.");
        return actual.enabled;
      },
    });
    preferences.set(r.id, preference);
  }
  version++; error = "";
  preference.set(!preference.get().value);
}
async function runAction(id: string, action: Action) {
  if (actions.has(id) || preferences.get(id)?.get().pending) return;
  const generation = cacheSession();
  version++; actions.set(id, action); error = ""; publish();
  try {
    if (action === "delete") {
      await api.deleteRoutine(id);
      if (generation === cacheSession()) {
        routines = routines?.filter(r => r.id !== id) ?? null;
        preferences.get(id)?.dispose(); preferences.delete(id);
      }
    } else {
      const actual = await api.runRoutine(id);
      if (generation === cacheSession()) routines = routines?.map(r => r.id === id ? actual : r) ?? [actual];
    }
  } catch (cause) { if (generation === cacheSession()) fail(cause); }
  finally {
    if (generation === cacheSession()) {
      actions.delete(id); version++; publish();
      await reloadRoutines();
    }
  }
}
async function create(input: Parameters<typeof api.createRoutine>[0]): Promise<boolean> {
  if (creating !== null) return false;
  const generation = cacheSession();
  version++; creating = input.title || input.prompt; error = ""; publish();
  try {
    const actual = await api.createRoutine(input);
    if (generation !== cacheSession()) return false;
    routines = [...(routines ?? []).filter(r => r.id !== actual.id), actual];
    return true;
  } catch (cause) {
    if (generation === cacheSession()) fail(cause instanceof ApiError && cause.status < 500 ? cause : new Error("Creation could not be confirmed. Check Routines before retrying."));
    return false;
  }
  finally { if (generation === cacheSession()) { creating = null; version++; publish(); } }
}
onCacheSessionReset(() => {
  version++; for (const pref of preferences.values()) pref.dispose(); preferences.clear(); actions.clear(); routines = null; creating = null; error = ""; publish();
});
export function useRoutines() {
  const state = useSyncExternalStore(subscribe, () => snapshot);
  return { ...state, toggle, run: (id: string) => runAction(id, "run"), remove: (id: string) => runAction(id, "delete"), create };
}
