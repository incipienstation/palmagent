import { useCallback, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import { readUpdateSnapshot, useUpdateSnapshot } from "./update-state";
import { cacheSession, onCacheSessionReset } from "./query-lifecycle";

// Drafts involved in an in-flight action outlive their screen. Async rollback
// updates this tab's current draft even if the user navigated away and back.
const values = new Map<string, unknown>();
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export function useActionState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  if (!values.has(key)) values.set(key, readUpdateSnapshot<T>(key) ?? (typeof initial === "function" ? (initial as () => T)() : initial));
  const value = useSyncExternalStore(subscribe, () => values.get(key) as T);
  useUpdateSnapshot(key, () => values.get(key));
  const generation = cacheSession();
  const set = useCallback<Dispatch<SetStateAction<T>>>(next => {
    if (generation !== cacheSession()) return;
    values.set(key, typeof next === "function" ? (next as (previous: T) => T)(values.get(key) as T) : next);
    listeners.forEach(fn => fn());
  }, [key, generation]);
  return [value, set];
}
export function forgetActionState(key: string) { values.delete(key); listeners.forEach(fn => fn()); }
onCacheSessionReset(() => { values.clear(); listeners.forEach(fn => fn()); });
