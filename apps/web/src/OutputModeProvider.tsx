import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

// "Output mode" — how much agent MACHINERY (tool_call / tool_result / status) the
// event log shows. Prose (assistant markdown), question cards, the final result,
// and errors are signal and stay visible in EVERY mode; this only governs the
// density of the machinery band beneath them.
//   compact  — machinery collapsed to a one-line summary AND raw status lifecycle
//              noise (init/turn/reasoning) hidden; tap a row to expand its detail.
//   default  — machinery one-line summary (today's density), status shown; tap to
//              expand. The middle option, and the default.
//   verbose  — machinery expanded by default to its full, untruncated detail.
// Modelled as a context (not a bare hook) so the Settings toggle and every open
// EventLog stay in sync the instant the user changes it — mirrors ThemeProvider.

export type OutputMode = "compact" | "default" | "verbose";

const STORAGE_KEY = "pref:output-mode";

function readInitial(): OutputMode {
  if (typeof window === "undefined") return "default";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "compact" || stored === "verbose" ? stored : "default";
  } catch {
    return "default";
  }
}

type OutputModeContextValue = {
  mode: OutputMode;
  setMode: (mode: OutputMode) => void;
};

const OutputModeContext = createContext<OutputModeContextValue | null>(null);

export function OutputModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<OutputMode>(readInitial);
  const setMode = useCallback((next: OutputMode) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore (private mode / no storage) — a non-persisted mode still works for the session
    }
    setModeState(next);
  }, []);
  return <OutputModeContext.Provider value={{ mode, setMode }}>{children}</OutputModeContext.Provider>;
}

export function useOutputMode(): OutputModeContextValue {
  const ctx = useContext(OutputModeContext);
  if (!ctx) throw new Error("useOutputMode must be used within an OutputModeProvider");
  return ctx;
}
