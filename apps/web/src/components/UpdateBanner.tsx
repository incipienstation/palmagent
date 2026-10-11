import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useToastObstacle } from "../hooks/useToastObstacle";
import { retryUpdate, usePwaFailure } from "../pwa";

export function UpdateBanner() {
  const toastObstacle = useToastObstacle();
  const failed = usePwaFailure();
  const [progress, setProgress] = useState(10);

  useEffect(() => {
    if (failed) return;
    setProgress(10);
    // Visual feedback only: the worker has no measurable download progress.
    // Approach 90%; the existing update flow reloads on success.
    const timer = setInterval(() => setProgress((value) => value + (90 - value) * 0.1), 800);
    return () => clearInterval(timer);
  }, [failed]);

  return <div ref={toastObstacle} role="status" className="flex shrink-0 items-center gap-3 bg-card/95 px-4 pt-2 pb-[calc(8px+var(--safe-bottom))]">
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <p className="text-xs text-muted-foreground">{failed ? "Update paused" : "Updating Palmagent…"}</p>
      {!failed && <Progress
        value={progress}
        aria-label="Palmagent update"
        aria-valuetext="Updating Palmagent"
        className="h-1"
      />}
    </div>
    {failed && <Button variant="outline" size="sm" onClick={retryUpdate}>Retry</Button>}
  </div>;
}
