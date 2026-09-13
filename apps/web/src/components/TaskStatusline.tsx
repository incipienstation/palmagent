import { useEffect, useState } from "react";
import type { AccountLimits, AgentKind, CodexLimitBucket, LimitWindow } from "@palmagent/shared";
import { api } from "../api";
import { Badge } from "./ui/badge";
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

function WindowLine({ name, limit, now, stale }: { name: string; limit: LimitWindow; now: number; stale: boolean }) {
  const expired = limit.resetsAt !== null && limit.resetsAt <= now;
  const remaining = limit.usedPercent === null ? null : Math.max(0, 100 - limit.usedPercent);
  return <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
    <span>{name}</span>
    <Badge variant={!stale && !expired && remaining !== null && remaining <= 10 ? "destructive" : "secondary"}>
      {expired ? "Awaiting refresh" : remaining === null ? "Remaining unknown" : `${Number(remaining.toFixed(1))}% left`}
    </Badge>
    {limit.resetsAt !== null && <span className="text-muted-foreground" title={new Date(limit.resetsAt).toLocaleString()}>
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
  const stale = now - report.checkedAt > 360_000;
  if (report.state !== "ready") return <span className="text-xs text-muted-foreground">
    {report.state === "error" ? "Account limits temporarily unavailable" : "This account does not report subscription limits"}
  </span>;
  const primary = report.agent === "codex" ? report.buckets[0] : undefined;
  return <div className="flex min-w-0 items-start justify-between gap-2">
    <div className="flex min-w-0 flex-col gap-1">
      {stale && <span className="text-xs text-muted-foreground">Outdated account limits</span>}
      {report.agent === "claude" ? <>
        {report.fiveHour && <WindowLine name="5h" limit={report.fiveHour} now={now} stale={stale} />}
        {report.sevenDay && <WindowLine name="Weekly" limit={report.sevenDay} now={now} stale={stale} />}
        {!report.fiveHour && !report.sevenDay && <span className="text-xs">Claude account limits</span>}
      </> : primary && <>
        {primary.id !== "codex" && <span className="truncate text-xs">{primary.name}</span>}
        <CodexWindows bucket={primary} now={now} stale={stale} />
        {!primary.primary && !primary.secondary && <span className="text-xs">Codex account credits</span>}
      </>}
    </div>
    <Sheet>
      <SheetTrigger asChild><Button variant="ghost" size="sm" aria-label="Account limit details">Details</Button></SheetTrigger>
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
    </Sheet>
  </div>;
}

export function TaskStatusline({ taskId, agent }: { taskId: string; agent: AgentKind }) {
  const [report, setReport] = useState<AccountLimits | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let stopped = false, pending = false;
    const refresh = async () => {
      if (document.visibilityState === "hidden" || pending) return;
      pending = true;
      try {
        const next = await api.getAccountLimits(taskId);
        if (!stopped) { setReport(next); setFailed(false); setNow(Date.now()); }
      } catch {
        if (!stopped) { setReport(null); setFailed(true); }
      } finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { setNow(Date.now()); void refresh(); }, 30_000);
    const visible = () => { setNow(Date.now()); void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { stopped = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [taskId]);
  return <section aria-label="Account limits" className="min-w-0">
    {report && report.agent === agent ? <LimitsView report={report} now={now} />
      : <span className="text-xs text-muted-foreground">{failed ? "Account limits temporarily unavailable" : "Checking account limits…"}</span>}
  </section>;
}
