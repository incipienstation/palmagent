import type { AccountLimits, CodexLimitBucket, LimitWindow } from "@palmagent/shared";
import { cn } from "../lib/utils";

export function duration(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (hours < 24) return `${hours}h${rest ? ` ${rest}m` : ""}`;
  return `${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
}

export function windowName(minutes: number | null, fallback: string): string {
  if (minutes === null || minutes <= 0) return fallback;
  if (minutes === 10080) return "Weekly";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export function windowState(limit: LimitWindow, now: number, stale: boolean) {
  const expired = limit.resetsAt !== null && limit.resetsAt <= now;
  const remaining = limit.usedPercent === null ? null : Math.max(0, 100 - limit.usedPercent);
  return { expired, remaining, low: !stale && !expired && remaining !== null && remaining <= 10 };
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

export function AccountLimitDetails({ report, now }: { report: AccountLimits; now: number }) {
  const stale = now - report.checkedAt > 360_000;
  if (report.state !== "ready") return <p className="text-sm text-muted-foreground">
    {report.state === "error" ? "Limits unavailable" : "Limits not reported"}
  </p>;
  return <div className="flex flex-col gap-4">
    {stale && <p className="text-sm text-muted-foreground">These limits are outdated. Reconnect to get a fresh report.</p>}
    {report.agent === "claude" ? <>
      {report.fiveHour && <WindowLine name="5h" limit={report.fiveHour} now={now} stale={stale} />}
      {report.sevenDay && <WindowLine name="Weekly" limit={report.sevenDay} now={now} stale={stale} />}
      {report.modelLimits.map(({ name, window }) => <WindowLine key={name} name={`${name} · Weekly`} limit={window} now={now} stale={stale} />)}
      {report.extraUsage && <p className="text-sm">Extra usage enabled{report.extraUsage.usedPercent !== null ? ` · ${report.extraUsage.usedPercent}% used` : ""}</p>}
    </> : report.buckets.map((bucket) => <div key={bucket.id} className="flex min-w-0 flex-col gap-2">
      {(report.buckets.length > 1 || bucket.name !== "Codex") && <h3 className="text-sm font-medium break-words">{bucket.name}</h3>}
      <CodexWindows bucket={bucket} now={now} stale={stale} />
      {bucket.credits && <p className="text-xs">{bucket.credits.unlimited ? "Unlimited credits" : bucket.credits.balance !== null ? `Credits: ${bucket.credits.balance}` : "Credits available"}</p>}
    </div>)}
  </div>;
}
