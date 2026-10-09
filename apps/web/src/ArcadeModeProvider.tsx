import { createContext, useContext, type ReactNode } from "react";
import { useStoredPreference } from "./hooks/useStoredPreference";

// Keep the original key so existing device preferences survive the rename.
const STORAGE_KEY = "pref:adhd-mode";

function readInitial(): "on" | "off" {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "on" ? "on" : "off";
  } catch {
    return "off";
  }
}

const ArcadeModeContext = createContext<{
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
} | null>(null);

export function ArcadeModeProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useStoredPreference(STORAGE_KEY, readInitial);
  const enabled = value === "on";

  return <ArcadeModeContext.Provider value={{ enabled, setEnabled: next => setValue(next ? "on" : "off") }}>
    {children}
  </ArcadeModeContext.Provider>;
}

export function useArcadeMode() {
  const context = useContext(ArcadeModeContext);
  if (!context) throw new Error("useArcadeMode must be used within an ArcadeModeProvider");
  return context;
}
