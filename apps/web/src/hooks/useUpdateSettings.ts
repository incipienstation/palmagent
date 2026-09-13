import { useEffect, useRef, useState } from "react";
import type { UpdateSettingsChange, UpdateSettingsStatus } from "@palmagent/shared";
import { api } from "../api";

export function useUpdateSettings() {
  const [status, setStatus] = useState<UpdateSettingsStatus | null>(null);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);

  async function request(change?: UpdateSettingsChange) {
    if (pending.current) return;
    pending.current = true;
    const current = ++generation.current;
    setBusy(true);
    setSaving(Boolean(change));
    setError(null);
    const markUnknown = () => {
      if (current !== generation.current) return;
      setStatus((previous) => previous ? { ...previous, availability: "unavailable", settings: null } : null);
      setStale(true);
    };
    try {
      const next = change ? await api.updateSettings.change(change) : await api.updateSettings.get();
      if (current === generation.current) { setStatus(next); setStale(false); }
    } catch (cause) {
      if (current !== generation.current) return;
      setError(cause instanceof Error ? cause.message : "Could not load update settings.");
      if (change) {
        // A timeout can occur after a preference was saved. Reconcile actual
        // state instead of presenting an optimistic rollback as confirmed.
        try {
          const actual = await api.updateSettings.get();
          if (current === generation.current) { setStatus(actual); setStale(false); }
        } catch { markUnknown(); }
      } else markUnknown();
    } finally {
      if (current === generation.current) { pending.current = false; setBusy(false); setSaving(false); }
    }
  }

  useEffect(() => {
    pending.current = false;
    void request();
    return () => { generation.current++; };
  }, []);

  return { status, busy, saving, stale, error, reload: () => request(), change: (change: UpdateSettingsChange) => request(change) };
}
