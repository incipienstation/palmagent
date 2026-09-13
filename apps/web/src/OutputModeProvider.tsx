import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

// Compact groups background work per turn; Default groups adjacent work and
// shows a short progress preview; Verbose exposes all recorded events.
// Questions, failures, final answers and unclassified legacy prose stay visible.
// The setting also controls task metadata and usage density.
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
