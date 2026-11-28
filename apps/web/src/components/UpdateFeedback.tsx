import { createContext, useContext, type ReactNode } from "react";
import { retryServerReads, useServerRestart } from "../update-recovery";
import { Pending } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { useToastObstacle } from "../hooks/useToastObstacle";
import { retryUpdate, usePwaUpdate, usePwaUpdateStage, type PwaUpdateStage } from "../pwa";

const stages: Record<PwaUpdateStage, string> = {
  checking: "Checking update…",
  downloading: "Downloading update…",
  ready: "Waiting to apply update…",
  saving: "Saving your changes…",
  applying: "Applying update…",
  paused: "Update paused",
};

const UpdateFeedbackContext = createContext(false);
export const useUpdateFeedback = () => useContext(UpdateFeedbackContext);

export function UpdateFeedback({ children }: { children: ReactNode }) {
  const toastObstacle = useToastObstacle();
  const restarting = useServerRestart();
  const updating = usePwaUpdate();
  const stage = usePwaUpdateStage();
  const active = Boolean(restarting) || updating;
  const paused = updating && stage === "paused";
  const slow = !updating && restarting === "delayed";
  const label = updating ? stages[stage] : slow ? "Waiting for Palmagent to restart…" : "Updating Palmagent…";

  return <UpdateFeedbackContext.Provider value={active}>
    <div className="flex h-app flex-col">
      <div className="min-h-0 flex-1">{children}</div>
      {active && <div ref={toastObstacle} role="status" aria-label="Palmagent update"
        className="flex shrink-0 items-center justify-center gap-3 bg-card px-4 pt-2 pb-[calc(8px+var(--safe-bottom))] text-xs text-muted-foreground">
        {paused ? <span>{label}</span> : <Pending>{label}</Pending>}
        {(paused || slow) && <Button variant="outline" size="sm" onClick={paused ? retryUpdate : retryServerReads}>Retry</Button>}
      </div>}
    </div>
  </UpdateFeedbackContext.Provider>;
}
