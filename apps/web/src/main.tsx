import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { OutputModeProvider } from "./OutputModeProvider";
import { ThemeProvider } from "./ThemeProvider";
import { setupBackGuard } from "./backGuard";
import { Toaster } from "./components/ui/toaster";
import { TooltipProvider } from "./components/ui/tooltip";
import { initViewportHeight } from "./viewport";
import { startPwaUpdates } from "./pwa";
import { restoreScreenPosition, restoreUpdateState } from "./update-state";
import "./index.css";

// Mirror window.innerHeight into --app-height before first paint so the h-app
// shells size to the real viewport — dodges the iOS standalone-PWA dvh
// over-measurement that drops the bottom TabBar on reload (see viewport.ts).
initViewportHeight();

// Standalone-only: guard the system Back button at the app root so a stray tap
// can't close the installed PWA — first back warns, a second exits (see backGuard.ts).
setupBackGuard();

// ThemeProvider keeps the .dark class + theme-color-meta in sync (the no-flash
// inline bootstrap in index.html applies the initial theme before first paint).
// Toaster + TooltipProvider are mounted app-wide (above AuthGate) so transient
// feedback and tooltips work on every route, including the login/enroll gate.
async function boot() {
  await restoreUpdateState();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ThemeProvider>
        <OutputModeProvider>
          <TooltipProvider>
            <App />
            <Toaster />
          </TooltipProvider>
        </OutputModeProvider>
      </ThemeProvider>
    </StrictMode>,
  );

  restoreScreenPosition();
  startPwaUpdates();
}
void boot().catch(() => {
  document.getElementById("root")!.textContent = "Could not restore your draft. Reload to retry.";
});
