import { useEffect, useSyncExternalStore } from "react";
import { onUpdatesChanged } from "../update-events";
import type { UpdateAction, UpdateSettingsChange, UpdateSettingsStatus } from "@palmagent/shared";
import { api } from "../api";
import { createOptimisticPreference } from "../optimistic-preference";
import { onCacheSessionReset } from "../read-cache";
import { toast } from "../components/ui/toaster";

type Action = UpdateAction["action"] | "load" | null;
type Preference = { autoUpdate: boolean; channel: "stable" | "preview" };
let status: UpdateSettingsStatus | null = null;
let action: Action = null;
let error: string | null = null;
let stale = false;
let epoch = 0;
let refreshPending = false;
let preference: ReturnType<typeof createOptimisticPreference<Preference>> | undefined;
const listeners = new Set<() => void>();
let snapshot = { status, busy: true, saving: false, stale, error, action } as {
  status: UpdateSettingsStatus | null; busy: boolean; saving: boolean; stale: boolean; error: string | null; action: Action;
};
function publish() {
  const pref = preference?.get();
  const settings = status?.settings;
  const projected = status && settings && pref ? { ...status, settings: { ...settings, ...pref.value,
    // Discovery belongs to the confirmed channel. Never install its target while
    // another channel is selected or any preference write is unresolved.
    ...(settings.channel !== pref.value.channel ? { discovery: undefined, pending: undefined } : {}),
  } } : status;
  snapshot = { status: stale || pref?.stale ? status ? { ...status, availability: "unavailable", settings: null } : null : projected, busy: Boolean(action) || Boolean(pref?.pending), saving: Boolean(pref?.pending), stale: stale || Boolean(pref?.stale), error, action };
  listeners.forEach(fn => fn());
  if (!snapshot.busy && refreshPending) { refreshPending = false; void request(); }
}
function accept(next: UpdateSettingsStatus) {
  status = next; stale = false;
  if (next.settings) {
    const value = { autoUpdate: next.settings.autoUpdate, channel: next.settings.channel };
    if (preference) preference.observe(value);
    else {
      const generation = epoch;
      preference = createOptimisticPreference(value, {
        equal: (a, b) => a.autoUpdate === b.autoUpdate && a.channel === b.channel,
        changed: publish,
        failed: cause => {
          error = cause instanceof Error ? cause.message : "Could not save update settings.";
          toast({ title: error, variant: "destructive" });
        },
        save: async (target, previous) => {
          let next = status!;
          // Disable automation before a channel change; enable it only after
          // the selected channel is saved, so a coalesced choice cannot trigger
          // an automatic update from the previously selected channel.
          if (!target.autoUpdate && previous.autoUpdate) next = await api.updateSettings.change({ autoUpdate: false });
          if (generation !== epoch) throw new Error("Session changed.");
          if (target.channel !== previous.channel) next = await api.updateSettings.change({ channel: target.channel });
          if (generation !== epoch) throw new Error("Session changed.");
          if (target.autoUpdate && !previous.autoUpdate) next = await api.updateSettings.change({ autoUpdate: true });
          if (generation === epoch) status = next;
          if (!next.settings) throw new Error("Update settings are unavailable.");
          return { autoUpdate: next.settings.autoUpdate, channel: next.settings.channel };
        },
        recover: async () => {
          const next = await api.updateSettings.get();
          if (generation === epoch) status = next;
          if (!next.settings) throw new Error("Update settings are unavailable.");
          return { autoUpdate: next.settings.autoUpdate, channel: next.settings.channel };
        },
      });
    }
  }
}
async function request(operation?: UpdateAction) {
  if (action || preference?.get().pending) { if (!operation) refreshPending = true; return; }
  const generation = epoch;
  action = operation?.action ?? "load"; error = null; publish();
  try {
    const next = operation ? await api.updateSettings.action(operation) : await api.updateSettings.get();
    if (generation === epoch) accept(next);
  } catch (cause) {
    if (generation !== epoch) return;
    error = cause instanceof Error ? cause.message : "Could not load update settings.";
    if (operation) toast({ title: error, variant: "destructive" });
    try { if (operation?.action !== "install") throw cause; const next = await api.updateSettings.get(); if (generation === epoch) accept(next); }
    catch { if (generation === epoch) stale = true; }
  } finally { if (generation === epoch) { action = null; publish(); } }
}
onUpdatesChanged(() => { void request(); });
onCacheSessionReset(() => {
  epoch++; preference?.dispose(); preference = undefined; status = null; action = null; error = null; stale = false; refreshPending = false; publish();
});
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export function useUpdateSettings() {
  const state = useSyncExternalStore(subscribe, () => snapshot);
  useEffect(() => { void request(); }, []);
  return { ...state, reload: () => request({ action: "check" }), install: (version: string) => request({ action: "install", version }),
    change: (change: UpdateSettingsChange) => {
      if (action || !preference || status?.availability !== "available") return;
      error = null;
      preference.set({ ...preference.get().value, ...change });
    },
  };
}
