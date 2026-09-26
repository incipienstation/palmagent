import { useId } from "react";
import { ChevronDown } from "lucide-react";
import type { AccountLimits, AgentKind, CodexLimitBucket, LimitWindow } from "@palmagent/shared";
import { useTaskAccountLimits } from "../hooks/useTaskAccountLimits";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "./ui/sheet";

function duration(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (hours < 24) return `${hours}h${rest ? ` ${rest}m` : ""}`;
  return `${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
}

function windowName(minutes: number | null, fallback: string): string {
  if (minutes === null || minutes <= 0) return fallback;
  if (minutes === 10080) return "Weekly";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function windowState(limit: LimitWindow, now: number, stale: boolean) {
  const expired = limit.resetsAt !== null && limit.resetsAt <= now;
  const remaining = limit.usedPercent === null ? null : Math.max(0, 100 - limit.usedPercent);
  return { expired, remaining, low: !stale && !expired && remaining !== null && remaining <= 10 };
}

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

function WindowLine({ name, limit, now, stale }: { name: string; limit: LimitWindow; now: number; stale: boolean }) {
  const { expired, remaining, low } = windowState(limit, now, stale);
  return <div className="flex min-w-0 flex-col gap-1 text-sm tabular-nums">
    <div className="flex items-start justify-between gap-4">
      <span className="min-w-0 break-words">{name}</span>
      <span className={cn("shrink-0", low ? "text-destructive" : "text-muted-foreground")}>
        {expired ? "Awaiting refresh" : remaining === null ? "Remaining unknown" : `${Number(remaining.toFixed(1))}% left`}
      </span>
    </div>
    {limit.resetsAt !== null && <span className="text-xs text-muted-foreground" title={new Date(limit.resetsAt).toLocaleString()}>
      {expired ? "Reset time passed" : `Resets in ${duration(limit.resetsAt - now)}`}
    </span>}
  </div>;
}

function CodexWindows({ bucket, now, stale }: { bucket: CodexLimitBucket; now: number; stale: boolean }) {
  return <>
    {bucket.primary && <WindowLine name={windowName(bucket.primary.windowMinutes, "Primary")} limit={bucket.primary} now={now} stale={stale} />}
    {bucket.secondary && <WindowLine name={windowName(bucket.secondary.windowMinutes, "Secondary")} limit={bucket.secondary} now={now} stale={stale} />}
  </>;
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
      <Button variant="ghost" className="h-auto min-h-11 w-full justify-start rounded-xl px-1 py-1.5" aria-label="Account limit details" aria-describedby={summaryId}>
        <span id={summaryId} className="flex min-w-0 flex-1 flex-col gap-1 text-left text-xs font-normal text-muted-foreground">
          {primary && primary.id !== "codex" && <span className="truncate">{primary.name}</span>}
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {available.length > 0 ? <>
              <span>{stale ? "Outdated" : "Remaining"}</span>
              {available.map(({ name, limit }, index) => <WindowSummary key={index} name={name} limit={limit} now={now} stale={stale} />)}
            </> : <span>{report.agent === "claude" ? "Claude account limits" : "Codex account credits"}</span>}
          </span>
          {lowWindows.map(({ name, limit }, index) => <span key={index} className="whitespace-normal text-destructive">
            {name} low · Resets in {duration(limit.resetsAt! - now)}
          </span>)}
        </span>
        <ChevronDown data-icon="inline-end" className="text-muted-foreground" />
      </Button>
    </SheetTrigger>
    <SheetContent className="max-h-[80dvh] overflow-y-auto">
      <SheetHeader>
        <SheetTitle>{report.agent === "claude" ? "Claude" : "Codex"} account limits</SheetTitle>
        <SheetDescription>Shared across sessions using this account. Checked {new Date(report.checkedAt).toLocaleTimeString()}. Updates every five minutes.</SheetDescription>
      </SheetHeader>
      <div className="flex flex-col gap-4 p-4">
        {stale && <p className="text-sm text-muted-foreground">These limits are outdated. Reconnect to get a fresh report.</p>}
        {report.agent === "claude" ? <>
          {report.fiveHour && <WindowLine name="5h" limit={report.fiveHour} now={now} stale={stale} />}
          {report.sevenDay && <WindowLine name="Weekly" limit={report.sevenDay} now={now} stale={stale} />}
          {report.modelLimits.map(({ name, window }) => <WindowLine key={name} name={`${name} · Weekly`} limit={window} now={now} stale={stale} />)}
          {report.extraUsage && <p className="text-sm">Extra usage enabled{report.extraUsage.usedPercent !== null ? ` · ${report.extraUsage.usedPercent}% used` : ""}</p>}
        </> : report.buckets.map((bucket) => <div key={bucket.id} className="flex min-w-0 flex-col gap-2">
          <h3 className="text-sm font-medium break-words">{bucket.name}</h3>
          <CodexWindows bucket={bucket} now={now} stale={stale} />
          {bucket.credits && <p className="text-xs">{bucket.credits.unlimited ? "Unlimited credits" : bucket.credits.balance !== null ? `Credits: ${bucket.credits.balance}` : "Credits available"}</p>}
        </div>)}
      </div>
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
