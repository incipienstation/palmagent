import { Pending } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { useToastObstacle } from "../hooks/useToastObstacle";
import { retryUpdate, usePwaUpdateStage, type PwaUpdateStage } from "../pwa";

const stages: Record<PwaUpdateStage, string> = {
  checking: "Checking update…",
  downloading: "Downloading update…",
  ready: "Waiting to apply update…",
  saving: "Saving your changes…",
  applying: "Applying update…",
  paused: "Update paused",
};

export function UpdateBanner() {
  const toastObstacle = useToastObstacle();
  const stage = usePwaUpdateStage();
  const failed = stage === "paused";
  const label = stages[stage];

  return <div ref={toastObstacle} role="status" aria-label="Palmagent update" className="flex shrink-0 items-center gap-3 bg-card/95 px-4 pt-2 pb-[calc(8px+var(--safe-bottom))]">
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <p className="text-xs text-muted-foreground">{failed ? label : <Pending>{label}</Pending>}</p>
    </div>
    {failed && <Button variant="outline" size="sm" onClick={retryUpdate}>Retry</Button>}
  </div>;
}
