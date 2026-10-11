import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useToastObstacle } from "../hooks/useToastObstacle";
import { retryUpdate, usePwaUpdateStage, type PwaUpdateStage } from "../pwa";

// Positions mark observed stages, not a measured percentage of downloaded bytes.
const stages: Record<PwaUpdateStage, { label: string; value: number }> = {
  checking: { label: "Checking update…", value: 10 },
  downloading: { label: "Downloading update…", value: 35 },
  ready: { label: "Waiting to apply update…", value: 65 },
  saving: { label: "Saving your changes…", value: 80 },
  applying: { label: "Applying update…", value: 95 },
  paused: { label: "Update paused", value: 0 },
};

export function UpdateBanner() {
  const toastObstacle = useToastObstacle();
  const stage = usePwaUpdateStage();
  const failed = stage === "paused";
  const { label, value } = stages[stage];

  return <div ref={toastObstacle} role="status" className="flex shrink-0 items-center gap-3 bg-card/95 px-4 pt-2 pb-[calc(8px+var(--safe-bottom))]">
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      {!failed && <Progress
        value={value}
        aria-label="Palmagent update"
        aria-valuetext={label}
        className="h-1"
      />}
    </div>
    {failed && <Button variant="outline" size="sm" onClick={retryUpdate}>Retry</Button>}
  </div>;
}
