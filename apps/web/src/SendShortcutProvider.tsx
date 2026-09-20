import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

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
  const [shortcut, setShortcutState] = useState<SendShortcut>(readInitial);
  const setShortcut = useCallback((next: SendShortcut) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Keep the preference usable for this session when storage is unavailable.
    }
    setShortcutState(next);
  }, []);
  return <SendShortcutContext.Provider value={{ shortcut, setShortcut }}>{children}</SendShortcutContext.Provider>;
}

export function useSendShortcut() {
  const context = useContext(SendShortcutContext);
  if (!context) throw new Error("useSendShortcut must be used within a SendShortcutProvider");
  return context;
}
