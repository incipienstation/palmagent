import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

// Light / dark theme system. The actual `.dark`-on-<html> + theme-color-meta is
// FIRST applied by the no-flash inline bootstrap in index.html (before first
// paint); this provider keeps that DOM state in sync with React state + reacts to
// OS changes when `system`. Keep the resolve logic here in sync with the inline
// bootstrap in index.html.

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "theme";
const DARK_BG = "#0d1117";
const LIGHT_BG = "#fbfcfd";

function prefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolveIsDark(theme: Theme): boolean {
  return theme === "dark" || (theme === "system" && prefersDark());
}

// Initial theme: ?__theme= query override (test determinism hook) → localStorage
// → 'system'. Mirrors the inline bootstrap so React's first render agrees with
// the pre-paint DOM.
function readInitialTheme(): Theme {
  if (typeof window === "undefined") return "system";
  try {
    const q = new URLSearchParams(window.location.search).get("__theme");
    const stored = q || window.localStorage.getItem(STORAGE_KEY) || "system";
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  const isDark = resolveIsDark(theme);
  document.documentElement.classList.toggle("dark", isDark);
  const meta = document.getElementById("theme-color-meta");
  if (meta) meta.setAttribute("content", isDark ? DARK_BG : LIGHT_BG);
}

type ThemeContextValue = {
  /** The user's preference (light | dark | system). */
  theme: Theme;
  /** The effective theme after resolving `system`. */
  resolved: "light" | "dark";
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readInitialTheme);
  const [resolved, setResolved] = useState<"light" | "dark">(() => (resolveIsDark(theme) ? "dark" : "light"));

  const setTheme = useCallback((next: Theme) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore (private mode / no storage)
    }
    setThemeState(next);
  }, []);

  // Apply on theme change + keep `resolved` accurate.
  useEffect(() => {
    applyTheme(theme);
    setResolved(resolveIsDark(theme) ? "dark" : "light");
  }, [theme]);

  // React to OS scheme changes only while following `system`.
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      applyTheme("system");
      setResolved(prefersDark() ? "dark" : "light");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  return <ThemeContext.Provider value={{ theme, resolved, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
