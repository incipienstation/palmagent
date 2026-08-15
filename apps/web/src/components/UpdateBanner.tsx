import { RefreshCw, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { applyUpdate, dismissUpdate, usePwaApplying } from "../pwa";

// In-flow bottom banner (mobile thumb-zone): a new version was deployed. Tapping
// Refresh activates the waiting service worker and reloads onto it; dismiss hides
// it until the next deploy. Rendered as the last child of AppShell so it pushes
// content up rather than covering the task compose bar.
export function UpdateBanner() {
  const applying = usePwaApplying();

  function handleApply() {
    applyUpdate();
  }

  return (
    <div
      role="status"
      // Plane-2 chrome (translucent + blur), in normal flow at the bottom of the
      // shell so it pushes content up rather than covering the compose bar.
      className="flex shrink-0 items-center gap-3 border-t border-border bg-card/95 px-4 pt-3 pb-[calc(12px+var(--safe-bottom))] backdrop-blur-md"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent">
        <RefreshCw className={cn("size-4 text-blue", applying && "animate-spin")} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-strong">Update available</p>
        <p className="truncate text-xs text-muted-foreground">
          {applying ? "Applying update…" : "A new version was just deployed."}
        </p>
      </div>
      <Button size="sm" onClick={handleApply} disabled={applying}>
        {applying ? <RefreshCw className="size-3.5 animate-spin" /> : null}
        {applying ? "Updating…" : "Refresh"}
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Dismiss update" onClick={dismissUpdate} disabled={applying}>
        <X className="size-4" />
      </Button>
    </div>
  );
}
