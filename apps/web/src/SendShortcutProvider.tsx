import { useStoredPreference } from "./hooks/useStoredPreference";
import { createContext, useContext, type ReactNode } from "react";

export type SendShortcut = "modifier-enter" | "enter";
const STORAGE_KEY = "pref:send-shortcut";

function readInitial(): SendShortcut {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "enter" ? "enter" : "modifier-enter";
  } catch {
    return "modifier-enter";
  }
}

const SendShortcutContext = createContext<{
  shortcut: SendShortcut;
  setShortcut: (shortcut: SendShortcut) => void;
} | null>(null);

export function SendShortcutProvider({ children }: { children: ReactNode }) {
  const [shortcut, setShortcut] = useStoredPreference<SendShortcut>(STORAGE_KEY, readInitial);

  return <SendShortcutContext.Provider value={{ shortcut, setShortcut }}>{children}</SendShortcutContext.Provider>;
}

export function useSendShortcut() {
  const context = useContext(SendShortcutContext);
  if (!context) throw new Error("useSendShortcut must be used within a SendShortcutProvider");
  return context;
}
