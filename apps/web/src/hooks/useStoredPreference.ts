import { useCallback, useState } from "react";

/** Callers validate/migrate initial values; failed storage never blocks an in-tab preference. */
export function useStoredPreference<T extends string>(key: string, initial: () => T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(initial);
  const save = useCallback((next: T) => {
    try { window.localStorage.setItem(key, next); } catch { /* Keep this session usable. */ }
    setValue(next);
  }, [key]);
  return [value, save];
}
