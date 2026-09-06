import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

// Persist a text field to localStorage so any reload — the deploy-update
// Refresh, an accidental navigation, opening the app from a push notification —
// never drops in-progress typing. Writes immediately (no debounce) so the final
// keystroke survives a reload that lands right after it; the strings are tiny so
// the synchronous write is cheap.
export function useDraft(key: string, initial = ""): [string, Dispatch<SetStateAction<string>>] {
  const [value, setValue] = useState<string>(() => readDraft(key) ?? initial);
  useEffect(() => {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch {
      /* storage disabled/full — drafts are best-effort, never block typing */
    }
  }, [key, value]);
  return [value, setValue];
}

function readDraft(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Drop persisted drafts — call after a successful submit, before navigating away. */
export function clearDraft(...keys: string[]): void {
  for (const key of keys) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore — best-effort */
    }
  }
}

// Persist a boolean preference (e.g. a form toggle) to localStorage so the user's
// last choice is remembered across dispatches and reloads. Unlike useDraft this is
// a sticky preference — it is NOT cleared on submit. Defaults to `initial` until
// the user changes it once.
export function usePersistedFlag(key: string, initial = false): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [value, setValue] = useState<boolean>(() => {
    const raw = readDraft(key);
    return raw === null ? initial : raw === "1";
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, value ? "1" : "0");
    } catch {
      /* storage disabled/full — best-effort, never block */
    }
  }, [key, value]);
  return [value, setValue];
}

// String sibling of usePersistedFlag: persist a select/toggle value (repo, agent,
// permission, model, effort) so the dispatch form re-opens with the last-used
// choice instead of resetting to a default every time. Like usePersistedFlag this
// is a sticky preference — NOT cleared on submit (that's what useDraft is for, and
// why title/prompt deliberately stay drafts). The stored value is an opaque string
// cast back to T; the caller validates it where it matters (a stale repo id falls
// back to the first repo in loadRepos).
export function usePersistedString<T extends string>(
  key: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => (readDraft(key) as T | null) ?? initial);
  useEffect(() => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage disabled/full — best-effort, never block */
    }
  }, [key, value]);
  return [value, setValue];
}

// Per-subkey sticky preference: persist a JSON map under `key` and expose the
// entry for the current `sub`, falling back to `fallback` until that sub is set.
// This is how one control remembers a DIFFERENT choice per dimension —
// model/effort/permission per AGENT (sub = agent) and the worktree toggle per
// REPO (sub = repoId). Switching `sub` restores that sub's own last value instead
// of resetting to a default, and the choice is saved immediately on change (not
// gated on a dispatch/submit). Legacy non-map values written by the old single-key
// hooks (a plain string, or "1"/"0") fail the object check and reset gracefully.
export function usePersistedMapEntry<T extends string | boolean>(
  key: string,
  sub: string,
  fallback: T,
): [T, (next: T) => void] {
  const [map, setMap] = useState<Record<string, T>>(() => readMap<T>(key));
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(map));
    } catch {
      /* storage disabled/full — best-effort, never block */
    }
  }, [key, map]);
  const value = sub in map ? map[sub] : fallback;
  const setValue = (next: T) => setMap((m) => ({ ...m, [sub]: next }));
  return [value, setValue];
}

function readMap<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, T>)
      : {};
  } catch {
    return {};
  }
}
