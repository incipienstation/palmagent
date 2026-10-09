import { useId, useRef, useState, type RefObject } from "react";
import { ChevronDown, Minimize2 } from "lucide-react";
import { contextRemaining, type AccountLimits, type LimitWindow, type TaskState } from "@palmagent/shared";
import { useTaskAccountLimits } from "../hooks/useTaskAccountLimits";
import { AccountLimitDetails, duration, windowName, windowState } from "./AccountLimits";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "./ui/sheet";

function AllowanceGauge({ remaining }: { remaining: number }) {
  return <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="8" cy="8" r="6" opacity="0.2" />
    <circle cx="8" cy="8" r="6" pathLength="100" strokeDasharray={`${remaining} 100`} transform="rotate(-90 8 8)" />
  </svg>;
}

function WindowSummary({ name, limit, now, stale }: { name: string; limit: LimitWindow; now: number; stale: boolean }) {
  const { expired, remaining, low } = windowState(limit, now, stale);
  const value = expired ? "Refreshing" : remaining === null ? "Unknown" : `${Number(remaining.toFixed(1))}%`;
  return <span className={cn("inline-flex items-center gap-1 whitespace-nowrap", low && "text-destructive")}>
    <span>{name}</span>
    {!expired && remaining !== null && <AllowanceGauge remaining={remaining} />}
    <span className={cn("tabular-nums", !stale && !expired && remaining !== null && !low && "text-foreground")}>{value}</span>
  </span>;
}

function limitWindows(report: AccountLimits | null) {
  if (!report || report.state !== "ready") return [];
  const primary = report.agent === "codex" ? report.buckets[0] : undefined;
  const windows = report.agent === "claude"
    ? [{ name: "5h", limit: report.fiveHour }, { name: "Weekly", limit: report.sevenDay }]
    : [{ name: windowName(primary?.primary?.windowMinutes ?? null, "Primary"), limit: primary?.primary },
      { name: windowName(primary?.secondary?.windowMinutes ?? null, "Secondary"), limit: primary?.secondary }];
  return windows.filter((entry): entry is { name: string; limit: LimitWindow } => !!entry.limit);
}

export function TaskStatusline({ task, compacting, compactReason, onCompact, triggerRef }: {
  task: TaskState; compacting: boolean; compactReason?: string; onCompact: () => void; triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const { report: received, failed, now } = useTaskAccountLimits(task.taskId);
  const report = received?.agent === task.agent ? received : null;
  const summaryId = useId();
  const [open, setOpen] = useState(false);
  const compactAfterClose = useRef(false);
  const stale = !!report && now - report.checkedAt > 360_000;
  const available = limitWindows(report);
  const lowWindows = available.filter(({ limit }) => windowState(limit, now, stale).low && limit.resetsAt !== null);
  const primary = report?.state === "ready" && report.agent === "codex" ? report.buckets[0] : undefined;
  const usage = task.contextUsage;
  const remaining = compacting ? null : contextRemaining(usage);
  const contextLabel = compacting ? "Compacting…" : remaining === null ? "—" : `${Number(remaining.toFixed(1))}% left`;
  const accountLabel = !report ? failed ? "Limits unavailable" : "Checking limits…"
    : report.state !== "ready" ? report.state === "error" ? "Limits unavailable" : "Limits not reported"
    : task.agent === "claude" ? "Claude account limits" : "Codex account credits";
  return <section aria-label="Session usage" className="min-w-0">
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button ref={triggerRef} variant="ghost" className="h-auto min-h-10 w-full justify-start rounded-xl px-1 py-0.5" aria-label="Usage details" aria-describedby={summaryId}>
          <span id={summaryId} className="flex min-w-0 flex-1 flex-col gap-0.5 text-left text-xs font-normal text-muted-foreground">
            {primary && primary.id !== "codex" && <span className="truncate">{primary.name}</span>}
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {task.agent === "codex" && <span className="inline-flex items-center gap-1 whitespace-nowrap" aria-label={`Context ${contextLabel}`}>
                <span>Context</span>
                {remaining !== null && <AllowanceGauge remaining={remaining} />}
                <span className={cn("tabular-nums", remaining !== null && "text-foreground")}>{contextLabel}</span>
              </span>}
              {available.length ? <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>{stale ? "Outdated" : "Remaining"}</span>
                {available.map(({ name, limit }, index) => <WindowSummary key={index} name={name} limit={limit} now={now} stale={stale} />)}
              </span> : <span>{accountLabel}</span>}
            </span>
            {lowWindows.map(({ name, limit }, index) => <span key={index} className="whitespace-normal leading-tight text-destructive">
              {name} low · Resets in {duration(limit.resetsAt! - now)}
            </span>)}
          </span>
          <ChevronDown data-icon="inline-end" className="text-muted-foreground" />
        </Button>
      </SheetTrigger>
      <SheetContent onCloseAutoFocus={event => {
        if (compactAfterClose.current) { event.preventDefault(); compactAfterClose.current = false; triggerRef.current?.focus({ preventScroll: true }); onCompact(); }
      }}>
        <SheetHeader>
          <SheetTitle>Session usage</SheetTitle>
          <SheetDescription>{task.agent === "codex" ? "Context capacity for this conversation and account limits shared across sessions." : "Account limits shared across sessions."}</SheetDescription>
        </SheetHeader>
        <SheetBody className="flex flex-col gap-4">
          {task.agent === "codex" && <>
            <section aria-label="Session context" className="flex flex-col gap-3 text-sm">
              <h3 className="font-semibold">Session context</h3>
              <p>{compacting ? "Compacting context…" : remaining !== null ? `${Number(remaining.toFixed(1))}% context remaining` : usage?.stale ? "Waiting for an updated context reading." : "Context capacity not reported yet."}</p>
              {usage && <>
                <p className="tabular-nums">{usage.stale || compacting ? "Last reading: " : ""}{usage.usedTokens.toLocaleString()} / {usage.windowTokens?.toLocaleString() ?? "unknown"} tokens used</p>
                <p className="text-muted-foreground">Last reported {new Date(usage.updatedAt).toLocaleTimeString()}. Updates when the agent reports usage.</p>
              </>}
              <Button variant="outline" disabled={!!compactReason} onClick={() => { compactAfterClose.current = true; setOpen(false); }}><Minimize2 data-icon="inline-start" />Compact context</Button>
              {compactReason && <p className="text-muted-foreground">{compactReason}</p>}
            </section>
            <Separator />
          </>}
          <section aria-label="Account limits" className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">{task.agent === "claude" ? "Claude" : "Codex"} account limits</h3>
            {report?.state === "ready" ? <>
              <p className="text-sm text-muted-foreground">Shared across sessions using this account. Checked {new Date(report.checkedAt).toLocaleTimeString()}. Updates every five minutes.</p>
              <AccountLimitDetails report={report} now={now} />
            </> : <p className="text-sm text-muted-foreground">{accountLabel}</p>}
          </section>
        </SheetBody>
      </SheetContent>
    </Sheet>
  </section>;
}
