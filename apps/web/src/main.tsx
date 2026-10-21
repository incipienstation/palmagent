import { restoreNewChatSubmission } from "./new-chat-state";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ArcadeModeProvider } from "./ArcadeModeProvider";
import { SendShortcutProvider } from "./SendShortcutProvider";
import { ShakeToDictateProvider } from "./ShakeToDictateProvider";
import { ThemeProvider } from "./ThemeProvider";
import { setupNavigation } from "./navigation";
import { Toaster } from "./components/ui/toaster";
import { TooltipProvider } from "./components/ui/tooltip";
import { initViewportHeight } from "./viewport";
import { startPwaUpdates } from "./pwa";
import { restoreScreenPosition, restoreUpdateState } from "./update-state";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./query-client";
import "./index.css";

// Mirror window.innerHeight into --app-height before first paint so the h-app
// shells size to the real viewport — dodges the iOS standalone-PWA dvh
// over-measurement that hides bottom controls on reload (see viewport.ts).
initViewportHeight();

// ThemeProvider keeps the .dark class + theme-color-meta in sync (the no-flash
// inline bootstrap in index.html applies the initial theme before first paint).
// Toaster + TooltipProvider are mounted app-wide (above AuthGate) so transient
// feedback and tooltips work on every route, including the login/enroll gate.
async function boot() {
  await setupNavigation();
  await restoreUpdateState();
  await restoreNewChatSubmission();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <ArcadeModeProvider>
              <SendShortcutProvider>
                <ShakeToDictateProvider>
                  <TooltipProvider>
                    <App />
                    <Toaster />
                  </TooltipProvider>
                </ShakeToDictateProvider>
              </SendShortcutProvider>
          </ArcadeModeProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </StrictMode>,
  );

  restoreScreenPosition();
  startPwaUpdates();
}
void boot().catch(() => {
  document.getElementById("root")!.textContent = "Could not restore your draft. Reload to retry.";
});
