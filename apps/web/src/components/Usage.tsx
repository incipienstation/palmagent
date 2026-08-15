import { useEffect, useState } from "react";
import type { AgentUsage } from "@palmagent/shared";
import { BarChart3 } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toaster";
import { api, ApiError } from "../api";
import { AppBar, AppShell } from "./AppShell";
import { AgentTag } from "./chips";
import { EmptyState } from "./EmptyState";

// Per-agent usage view. The two CLIs report asymmetric signal — Claude emits a
// USD cost + active time per turn, Codex emits token counts — so each card shows
// whichever metrics that agent actually reports (a zero metric is hidden).

function errMsg(e: unknown): string {
  return e instanceof ApiError || e instanceof Error ? e.message : String(e);
}

function fmtUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Plane-1 stat tile: value-over-eyebrow inside a muted well. Numbers use
// tabular-nums so a column of tiles stays optically aligned.
function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted px-3 py-2.5">
      <div className="text-[19px] leading-6 font-semibold tabular-nums text-strong">{value}</div>
      <div className="mt-0.5 text-[11px] font-semibold tracking-wide text-faint uppercase">
        {label}
      </div>
    </div>
  );
}

function UsageCard({ u }: { u: AgentUsage }) {
  // Tasks/turns always shown; the rest only when that CLI reported it. Keeping
  // the per-agent conditional metric logic — a zero field means "not reported".
  const tiles: { label: string; value: string }[] = [
    { label: "Tasks", value: String(u.taskCount) },
    { label: "Turns", value: String(u.turnCount) },
  ];
  if (u.durationMs > 0) tiles.push({ label: "Active time", value: fmtDuration(u.durationMs) });
  if (u.inputTokens > 0) tiles.push({ label: "Input tokens", value: fmtTokens(u.inputTokens) });
  if (u.outputTokens > 0) tiles.push({ label: "Output tokens", value: fmtTokens(u.outputTokens) });
  if (u.cachedInputTokens > 0)
    tiles.push({ label: "Cached tokens", value: fmtTokens(u.cachedInputTokens) });
  if (u.reasoningOutputTokens > 0)
    tiles.push({ label: "Reasoning tokens", value: fmtTokens(u.reasoningOutputTokens) });

  const hasCost = u.totalCostUsd > 0;

  return (
    <Card>
      <CardHeader className="flex-row items-baseline justify-between gap-3 p-4 pb-3">
        <AgentTag agent={u.agent} />
        {/* Hero numeral: total cost when the agent reports it (Claude); Codex has
            no cost signal, so we surface its turn count as the headline figure. */}
        {hasCost ? (
          <span className="text-[22px] leading-7 font-semibold tabular-nums text-strong">
            {fmtUsd(u.totalCostUsd)}
          </span>
        ) : (
          <span className="text-[12.5px] leading-4 text-faint">no cost reported</span>
        )}
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <div className="grid grid-cols-2 gap-2">
          {tiles.map((t) => (
            <Tile key={t.label} label={t.label} value={t.value} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// Tile-grid skeleton mirroring a loaded UsageCard (header chip + hero + 4 tiles)
// so the load shimmer reserves the right shape. The mock harness renders loaded
// state, so this never appears in visual snapshots.
function UsageCardSkeleton() {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 p-4 pb-3">
        <Skeleton className="h-5 w-16 rounded-full" />
        <Skeleton className="h-6 w-14" />
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <div className="grid grid-cols-2 gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[58px] w-full" />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function UsageView() {
  const [usage, setUsage] = useState<AgentUsage[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .getUsage()
      .then(setUsage)
      .catch((e) => {
        const msg = errMsg(e);
        setError(msg);
        toast({ title: "Couldn't load usage", description: msg, variant: "destructive" });
      });
  }, []);

  const loading = usage === null && !error;
  const isEmpty = usage !== null && usage.length === 0;

  return (
    <AppShell>
      <AppBar title="Usage" brand settings />
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 pb-[calc(var(--tabbar-h)+var(--banner-h)+24px)]">
        {error && <Alert variant="destructive">{error}</Alert>}

        {loading && (
          <>
            <UsageCardSkeleton />
            <UsageCardSkeleton />
          </>
        )}

        {isEmpty && !error && (
          <EmptyState
            icon={BarChart3}
            title="No usage yet"
            subtitle="Dispatch a task and its cost and token counts will start tracking here."
          />
        )}

        {usage?.map((u) => (
          <UsageCard key={u.agent} u={u} />
        ))}
      </div>
    </AppShell>
  );
}
