import { useToastObstacle } from "../hooks/useToastObstacle";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { retryUpdate, usePwaApplying, usePwaFailure } from "../pwa";

export function UpdateBanner() {
  const toastObstacle = useToastObstacle();
  const applying = usePwaApplying();
  const failed = usePwaFailure();
  return <div ref={toastObstacle} role="status" className="flex shrink-0 items-center gap-3 border-t border-border bg-card/95 px-4 pt-3 pb-[calc(12px+var(--safe-bottom))]">
    <RefreshCw className={cn("size-5 text-blue", applying && "animate-spin")} />
    <div className="min-w-0 flex-1">
      <p className="text-sm font-semibold text-strong">{failed ? "Update paused" : "Updating Palmagent…"}</p>
      <p className="text-xs text-muted-foreground">{failed ? "Your screen is still open. We could not safely finish the update." : "Your session keeps running. This screen will update automatically."}</p>
    </div>
    {failed && <Button size="sm" onClick={retryUpdate}>Retry</Button>}
  </div>;
}
