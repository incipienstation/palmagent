import { memo } from "react";
import { ChevronRight, Wrench } from "lucide-react";
import { activityLabel, type Activity } from "../transcript";
import type { OutputMode } from "../OutputModeProvider";
import { Button } from "./ui/button";
import { WorkingLabel } from "./WorkingLabel";
import { cn } from "../lib/utils";

// Compact tool chips and expandable progress, inspired by Beautiful UI:
// https://www.beautifului.dev/ — render only real events, with no timed reveals.
export const ActivitySummary = memo(function ActivitySummary({ activity, mode, open, onToggle, detailsLoading = false, detailsError, onRetry }: {
  activity: Activity; mode: OutputMode; open: boolean; onToggle: (activity: Activity, open: boolean) => void;
  detailsLoading?: boolean; detailsError?: boolean; onRetry?: () => unknown;
}) {
  const label = activityLabel(activity, mode);
  return <div data-activity className={cn("min-w-0 font-sans text-muted-foreground", !open && "mb-3")}>
    <Button variant="ghost" className={cn("h-auto min-h-11 flex-col items-stretch gap-2 text-left", activity.live ? "px-0 py-2" : "w-full rounded-xl border border-border px-3 py-2.5")}
      aria-label={label} title={label} aria-expanded={open} onClick={() => onToggle(activity, !open)}>
      <span className="flex min-w-0 items-center gap-2">
        {activity.live ? <WorkingLabel /> : <>
          <Wrench data-icon="inline-start" />
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </>}
        {(!activity.live || open) && <ChevronRight data-icon="inline-end" className={cn("transition-transform motion-reduce:transition-none", open && "rotate-90")} />}
      </span>
    </Button>
    {activity.live && open && <p className="mb-2 text-xs">{label}</p>}
    {!open && activity.preview && <div data-progress-preview className={cn("mt-2 border-l-2 border-border pl-3 text-[13px] break-words [overflow-wrap:anywhere]", mode === "compact" ? "line-clamp-1" : "line-clamp-2")}>{activity.preview}</div>}
    {open && detailsLoading && <p role="status" className="mb-2 text-xs">Loading activity details…</p>}
    {open && detailsError && <div role="alert" className="mb-2 flex items-center gap-2 text-xs">
      <span>Couldn’t load activity details.</span>
      {onRetry && <Button variant="outline" size="sm" onClick={() => { onRetry(); }}>Retry</Button>}
    </div>}
  </div>;
}, (previous, next) => previous.activity.key === next.activity.key &&
  previous.activity.items.length === next.activity.items.length && previous.activity.live === next.activity.live &&
  previous.activity.preview === next.activity.preview && previous.mode === next.mode && previous.open === next.open &&
  previous.detailsLoading === next.detailsLoading && previous.detailsError === next.detailsError && previous.onRetry === next.onRetry);
