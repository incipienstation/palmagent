import { useId } from "react";
import { ChevronDown } from "lucide-react";
import type { AccountLimits, AgentKind, LimitWindow } from "@palmagent/shared";
import { useTaskAccountLimits } from "../hooks/useTaskAccountLimits";
import { AccountLimitDetails, duration, windowName, windowState } from "./AccountLimits";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
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

function LimitsView({ report, now }: { report: AccountLimits; now: number }) {
  const summaryId = useId();
  const stale = now - report.checkedAt > 360_000;
  if (report.state !== "ready") return <span className="block px-1 py-1 text-xs text-muted-foreground">
    {report.state === "error" ? "Limits unavailable" : "Limits not reported"}
  </span>;
  const primary = report.agent === "codex" ? report.buckets[0] : undefined;
  const windows = report.agent === "claude"
    ? [{ name: "5h", limit: report.fiveHour }, { name: "Weekly", limit: report.sevenDay }]
    : [{ name: windowName(primary?.primary?.windowMinutes ?? null, "Primary"), limit: primary?.primary },
      { name: windowName(primary?.secondary?.windowMinutes ?? null, "Secondary"), limit: primary?.secondary }];
  const available = windows.filter((entry): entry is { name: string; limit: LimitWindow } => !!entry.limit);
  const lowWindows = available.filter(({ limit }) => windowState(limit, now, stale).low && limit.resetsAt !== null);
  return <Sheet>
    <SheetTrigger asChild>
      <Button variant="ghost" className="h-auto min-h-10 w-full justify-start rounded-xl px-1 py-0.5" aria-label="Account limit details" aria-describedby={summaryId}>
        <span id={summaryId} className="flex min-w-0 flex-1 flex-col gap-0.5 text-left text-xs font-normal text-muted-foreground">
          {primary && primary.id !== "codex" && <span className="truncate">{primary.name}</span>}
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {available.length > 0 ? <>
              <span>{stale ? "Outdated" : "Remaining"}</span>
              {available.map(({ name, limit }, index) => <WindowSummary key={index} name={name} limit={limit} now={now} stale={stale} />)}
            </> : <span>{report.agent === "claude" ? "Claude account limits" : "Codex account credits"}</span>}
          </span>
          {lowWindows.map(({ name, limit }, index) => <span key={index} className="whitespace-normal leading-tight text-destructive">
            {name} low · Resets in {duration(limit.resetsAt! - now)}
          </span>)}
        </span>
        <ChevronDown data-icon="inline-end" className="text-muted-foreground" />
      </Button>
    </SheetTrigger>
    <SheetContent>
      <SheetHeader>
        <SheetTitle>{report.agent === "claude" ? "Claude" : "Codex"} account limits</SheetTitle>
        <SheetDescription>Shared across sessions using this account. Checked {new Date(report.checkedAt).toLocaleTimeString()}. Updates every five minutes.</SheetDescription>
      </SheetHeader>
      <SheetBody className="flex flex-col gap-4">
        <AccountLimitDetails report={report} now={now} />
      </SheetBody>
    </SheetContent>
  </Sheet>;
}

export function TaskStatusline({ taskId, agent }: { taskId: string; agent: AgentKind }) {
  const { report, failed, now } = useTaskAccountLimits(taskId);
  return <section aria-label="Account limits" className="min-w-0">
    {report && report.agent === agent ? <LimitsView report={report} now={now} />
      : <span className="block px-1 py-1 text-xs text-muted-foreground">{failed ? "Limits unavailable" : "Checking limits…"}</span>}
  </section>;
}
