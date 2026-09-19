import { useSyncExternalStore } from "react";
import { api } from "../api";
import { toast } from "../components/ui/toaster";
let pending = false;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const publish = () => listeners.forEach(fn => fn());
async function signOut() {
  if (pending) return;
  pending = true; publish();
  try { await api.auth.logout(); window.location.reload(); }
  catch (error) {
    try { const actual = await api.auth.me(); if (actual.required && !actual.authenticated) { window.location.reload(); return; } }
    catch { /* Keep the page when session verification is unavailable. */ }
    toast({ title: "Couldn't sign out", description: error instanceof Error ? error.message : "Try again.", variant: "destructive" });
  } finally { pending = false; publish(); }
}
export function useSignOut() { return { signingOut: useSyncExternalStore(subscribe, () => pending), signOut }; }
