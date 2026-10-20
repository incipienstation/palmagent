import { useEffect, useSyncExternalStore } from "react";
import type { TelemetryStatus } from "@palmagent/shared/telemetry";
import { api } from "../api";
import { cacheSession, onCacheSessionReset } from "../query-lifecycle";

let snapshot = { status: null as TelemetryStatus | null, busy: false, error: "" };
const listeners = new Set<() => void>();
const publish = (patch: Partial<typeof snapshot>) => { snapshot = { ...snapshot, ...patch }; listeners.forEach(fn => fn()); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
async function request(enabled?: boolean) {
  if (snapshot.busy) return;
  const generation = cacheSession();
  publish({ busy: true, error: "" });
  try {
    const status = enabled === undefined ? await api.telemetry.get() : await api.telemetry.change(enabled);
    if (generation === cacheSession()) publish({ status });
  } catch {
    if (generation === cacheSession()) {
      publish({ error: "Could not save or load performance sharing. Try again." });
      // A failed response can follow a successful write. Reconcile before presenting a saved choice.
      if (enabled !== undefined) {
        try { const status = await api.telemetry.get(); if (generation === cacheSession()) publish({ status }); }
        catch { if (generation === cacheSession()) publish({ status: null }); }
      }
    }
  } finally { if (generation === cacheSession()) publish({ busy: false }); }
}
onCacheSessionReset(() => publish({ status: null, busy: false, error: "" }));
export function useTelemetrySettings() {
  const state = useSyncExternalStore(subscribe, () => snapshot);
  useEffect(() => {
    void request();
    const refresh = () => { if (document.visibilityState === "visible") void request(); };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, []);
  return { ...state, request };
}
