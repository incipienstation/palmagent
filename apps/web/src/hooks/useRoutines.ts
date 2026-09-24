import { useEffect, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Routine } from "@palmagent/shared";
import { api, ApiError } from "../api";
import { clientReadKeys } from "../client-query-keys";
import { routinesQueryOptions } from "../client-queries";
import { queryClient } from "../query-client";
import { cacheSession, onCacheSessionReset } from "../query-lifecycle";
import { createOptimisticPreference } from "../optimistic-preference";
import { toast } from "../components/ui/toaster";

type Action = "run" | "stop" | "delete";
const actions = new Map<string, Action>();
const preferences = new Map<string, ReturnType<typeof createOptimisticPreference<boolean>>>();
let creating: string | null = null;
let error = "";
const listeners = new Set<() => void>();
type RoutineSnapshot = { actions: Map<string, Action>; saving: Set<string>; stale: Set<string>; creating: string | null; error: string };
let snapshot: RoutineSnapshot = { actions: new Map(actions), saving: new Set<string>(), stale: new Set<string>(), creating, error };

function publish() {
  snapshot = {
    actions: new Map(actions),
    saving: new Set([...preferences].filter(([, preference]) => preference.get().pending).map(([id]) => id)),
    stale: new Set([...preferences].filter(([, preference]) => preference.get().stale).map(([id]) => id)),
    creating,
    error,
  };
  listeners.forEach((listener) => listener());
}

function fail(cause: unknown) {
  error = cause instanceof Error ? cause.message : "Something went wrong.";
  toast({ title: "Couldn't update routines", description: error, variant: "destructive" });
  publish();
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

function writeRoutine(actual: Routine): void {
  queryClient.setQueryData<Routine[]>(clientReadKeys.routines(), (current) => current
    ? current.map((routine) => routine.id === actual.id ? actual : routine)
    : [actual]);
}

export async function reloadRoutines(): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: clientReadKeys.routines(), refetchType: "active" });
}

function toggle(routine: Routine) {
  if (actions.has(routine.id)) return;
  let preference = preferences.get(routine.id);
  if (!preference) {
    const generation = cacheSession();
    preference = createOptimisticPreference(routine.enabled, {
      equal: (a, b) => a === b,
      changed: publish,
      failed: fail,
      save: async (enabled) => {
        const actual = await api.updateRoutine(routine.id, { enabled });
        if (generation === cacheSession()) writeRoutine(actual);
        return actual.enabled;
      },
      recover: async () => {
        const next = await queryClient.fetchQuery({ ...routinesQueryOptions(), staleTime: 0 });
        const actual = next.find((item) => item.id === routine.id);
        if (generation === cacheSession()) queryClient.setQueryData(clientReadKeys.routines(), next);
        if (!actual) throw new Error("This routine is no longer available.");
        return actual.enabled;
      },
    });
    preferences.set(routine.id, preference);
  }
  error = "";
  preference.set(!preference.get().value);
}

async function runAction(id: string, action: Action) {
  if (actions.has(id) || preferences.get(id)?.get().pending) return;
  const generation = cacheSession();
  actions.set(id, action);
  error = "";
  publish();
  try {
    if (action === "delete") {
      await api.deleteRoutine(id);
      if (generation === cacheSession()) {
        queryClient.setQueryData<Routine[]>(clientReadKeys.routines(), (current) => current?.filter((routine) => routine.id !== id));
        queryClient.removeQueries({ queryKey: clientReadKeys.routineRunsFor(id) });
        preferences.get(id)?.dispose();
        preferences.delete(id);
      }
    } else {
      const actual = await (action === "stop" ? api.stopRoutine(id) : api.runRoutine(id));
      if (generation === cacheSession()) writeRoutine(actual);
    }
  } catch (cause) {
    if (generation === cacheSession()) fail(cause);
  } finally {
    if (generation === cacheSession()) {
      actions.delete(id);
      publish();
      await reloadRoutines();
      if (action !== "delete") {
        await queryClient.invalidateQueries({ queryKey: clientReadKeys.routineRunsFor(id), refetchType: "active" });
      }
    }
  }
}

async function create(input: Parameters<typeof api.createRoutine>[0]): Promise<boolean> {
  if (creating !== null) return false;
  const generation = cacheSession();
  creating = input.title || input.script?.command || input.prompt || "Routine";
  error = "";
  publish();
  try {
    const actual = await api.createRoutine(input);
    if (generation !== cacheSession()) return false;
    queryClient.setQueryData<Routine[]>(clientReadKeys.routines(), (current) => current
      ? [...current.filter((routine) => routine.id !== actual.id), actual] : [actual]);
    return true;
  } catch (cause) {
    if (generation === cacheSession()) {
      fail(cause instanceof ApiError && cause.status < 500
        ? cause : new Error("Creation could not be confirmed. Check Routines before retrying."));
    }
    return false;
  } finally {
    if (generation === cacheSession()) { creating = null; publish(); }
  }
}

onCacheSessionReset(() => {
  for (const preference of preferences.values()) preference.dispose();
  preferences.clear();
  actions.clear();
  creating = null;
  error = "";
  publish();
});

export function useRoutines() {
  const query = useQuery(routinesQueryOptions());
  const state = useSyncExternalStore(subscribe, () => snapshot);

  useEffect(() => {
    if (!query.data) return;
    error = "";
    for (const routine of query.data) preferences.get(routine.id)?.observe(routine.enabled);
    publish();
  }, [query.data, query.dataUpdatedAt]);

  const routines = query.data?.filter((routine) => actions.get(routine.id) !== "delete").map((routine) => {
    const preference = preferences.get(routine.id)?.get();
    return preference
      ? { ...routine, enabled: preference.value, ...(preference.pending || preference.stale ? { nextRunAt: undefined } : {}) }
      : routine;
  }) ?? null;
  const queryError = query.data === undefined
    ? query.error instanceof Error ? query.error.message : query.error ? "Could not load routines." : ""
    : "";

  return {
    ...state,
    routines,
    error: state.error || queryError,
    toggle,
    stop: (id: string) => runAction(id, "stop"),
    run: (id: string) => runAction(id, "run"),
    remove: (id: string) => runAction(id, "delete"),
    create,
  };
}
