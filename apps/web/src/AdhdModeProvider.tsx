import { createContext, useContext, type ReactNode } from "react";
import { useStoredPreference } from "./hooks/useStoredPreference";

const STORAGE_KEY = "pref:adhd-mode";

function readInitial(): "on" | "off" {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "on" ? "on" : "off";
  } catch {
    return "off";
  }
}

const AdhdModeContext = createContext<{
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
} | null>(null);

export function AdhdModeProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useStoredPreference(STORAGE_KEY, readInitial);
  const enabled = value === "on";

  return <AdhdModeContext.Provider value={{ enabled, setEnabled: next => setValue(next ? "on" : "off") }}>
    {children}
  </AdhdModeContext.Provider>;
}

export function useAdhdMode() {
  const context = useContext(AdhdModeContext);
  if (!context) throw new Error("useAdhdMode must be used within an AdhdModeProvider");
  return context;
}
