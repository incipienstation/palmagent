import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { AgentInstallation, AgentKind, AgentUsage, AgentUsageMetric } from "@palmagent/shared";
import { RefreshCw } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { ScrollArea } from "./ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useAgentUpdate } from "../hooks/useAgentUpdate";
import { agentInstallationsQueryOptions, agentLimitsQueryOptions, usageQueryOptions } from "../client-queries";
import { clientReadKeys } from "../client-query-keys";
import { AppBar, AppShell } from "./AppShell";
import { AccountLimitDetails } from "./AccountLimits";

const agentName = (agent: AgentKind) => agent === "claude" ? "Claude Code" : "Codex";
const errMsg = (error: unknown) => error instanceof Error ? error.message : "Please try again.";
const tokens = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n);
const usd = (n: number) => n === 0 ? "$0" : `$${n.toFixed(n < 0.01 ? 4 : 2)}`;
function duration(ms: number) {
  const seconds = Math.round(ms / 1000), minutes = Math.floor(seconds / 60);
  return seconds < 60 ? `${seconds}s` : minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function UsageStats({ usage, unavailable }: { usage: AgentUsage | null | undefined; unavailable: boolean }) {
  if (usage === null && unavailable) return <p className="text-sm text-muted-foreground">Activity unavailable</p>;
  if (usage === null) return <Skeleton className="h-40 w-full" aria-label="Loading activity" />;
  if (!usage) return <p className="text-sm text-muted-foreground">No Palmagent activity yet.</p>;
  const metric = (key: AgentUsageMetric, format: (n: number) => string) =>
    (usage.reported ? usage.reported.includes(key) : usage[key] > 0) ? format(usage[key]) : "—";
  const values = [
    ["Tasks", String(usage.taskCount)], ["Turns", String(usage.turnCount)],
    ["Input tokens", metric("inputTokens", tokens)], ["Output tokens", metric("outputTokens", tokens)],
    ["Cached input", metric("cachedInputTokens", tokens)], ["Reasoning output", metric("reasoningOutputTokens", tokens)],
    ["Reported cost", metric("totalCostUsd", usd)], ["Active time", metric("durationMs", duration)],
  ];
  return <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
    {values.map(([label, value]) => <div key={label} className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium tabular-nums" aria-label={value === "—" ? `${label}: not reported` : undefined}>{value}</dd>
    </div>)}
  </dl>;
}

function Installation({ status, canUpdate, stale }: { status?: AgentInstallation; canUpdate: boolean; stale: boolean }) {
  const mutation = useAgentUpdate(status);
  if (!status && stale) return <p className="text-sm text-muted-foreground">Installation unavailable</p>;
  if (!status) return <Skeleton className="h-24 w-full" aria-label="Loading installation" />;
  const running = status.update.state === "running" || mutation.isPending;
  const external = status.installation === "external";
  return <div className="flex flex-col gap-3">
    <dl className="flex flex-col gap-2 text-sm">
      <div className="flex items-start justify-between gap-4"><dt className="text-muted-foreground">Installed version</dt><dd className="break-all text-right tabular-nums">{status.version ?? (status.installation === "missing" ? "Not installed" : "Unavailable")}</dd></div>
      <div className="flex items-start justify-between gap-4"><dt className="text-muted-foreground">Latest release</dt><dd className="break-all text-right tabular-nums">{status.latestVersion ?? "Unavailable"}</dd></div>
    </dl>
    {status.compatible === false && <p className="text-xs text-muted-foreground">This version is outside Palmagent’s tested CLI range.</p>}
    {status.releaseState === "error" && <p className="text-xs text-muted-foreground">Couldn’t check the latest release.</p>}
    {external && <p className="text-xs text-muted-foreground">Managed outside the native installer. Update it with its package manager on the host.</p>}
    {mutation.error && <Alert variant="destructive">{errMsg(mutation.error)}</Alert>}
    {status.update.state === "failed" && <Alert variant="destructive">{status.update.message}</Alert>}
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span role="status" className="text-xs text-muted-foreground">{running ? "Updating…" : status.update.message ?? `Checked ${new Date(status.checkedAt).toLocaleTimeString()}`}</span>
      {status.installation === "native" && <AlertDialog>
        <AlertDialogTrigger asChild><Button variant="outline" size="sm" disabled={!canUpdate || stale || running || status.latestVersion === status.version || status.releaseState === "error"} aria-label={`Update ${agentName(status.agent)}`}>{running ? "Updating…" : "Update"}</Button></AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Update {agentName(status.agent)}?</AlertDialogTitle>
            <AlertDialogDescription>Run the host’s CLI updater for the installation currently at {status.version}. It follows the CLI’s configured release channel. Palmagent will verify the installed version when it finishes.</AlertDialogDescription>
            {status.latestCompatible === false && <Alert variant="warning">The latest release is outside Palmagent’s tested CLI range. Some agent features may not work.</Alert>}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={running || stale} onClick={() => mutation.mutate()}>Update {agentName(status.agent)}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>}
    </div>
    {!canUpdate && status.installation === "native" && <p className="text-xs text-muted-foreground">Enable sign-in to manage host updates.</p>}
  </div>;
}

function AgentCard({ agent, installation, canUpdate, stale, usage, usageUnavailable, now }: {
  agent: AgentKind; installation?: AgentInstallation; canUpdate: boolean; stale: boolean;
  usage: AgentUsage | null | undefined; usageUnavailable: boolean; now: number;
}) {
  const limits = useQuery({ ...agentLimitsQueryOptions(agent), enabled: Boolean(installation?.version) });
  return <Card role="region" aria-label={agentName(agent)}>
    <CardHeader>
      <CardTitle role="heading" aria-level={2}>{agentName(agent)}</CardTitle>
      <CardDescription>Host installation</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-4">
      <Installation status={installation} canUpdate={canUpdate} stale={stale} />
      <Separator />
      <section aria-label={`${agentName(agent)} account limits`} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1"><h3 className="text-sm font-medium">Account limits</h3><p className="text-xs text-muted-foreground">Remaining allowance shared across this account’s sessions.</p></div>
        {limits.data ? <AccountLimitDetails report={limits.data} now={now} /> : limits.isFetching ? <Skeleton className="h-16 w-full" aria-label="Loading account limits" />
          : <p className="text-sm text-muted-foreground">{installation?.installation === "missing" ? "Install the CLI to read account limits." : "Limits unavailable"}</p>}
        {limits.error && limits.data && <p className="text-xs text-muted-foreground">Couldn’t refresh account limits. Showing the last report.</p>}
        {limits.data && <p className="text-xs text-muted-foreground">Checked {new Date(limits.data.checkedAt).toLocaleTimeString()}</p>}
      </section>
      <Separator />
      <section aria-label={`${agentName(agent)} Palmagent activity`} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1"><h3 className="text-sm font-medium">Palmagent activity</h3><p className="text-xs text-muted-foreground">All recorded tasks · — means not reported. Cost is CLI-reported, not your account bill.</p></div>
        <UsageStats usage={usage} unavailable={usageUnavailable} />
      </section>
    </CardContent>
  </Card>;
}

export function UsageView() {
  const query = useQuery(usageQueryOptions());
  const installations = useQuery(agentInstallationsQueryOptions());
  const client = useQueryClient();
  const [lastError, setLastError] = useState("");
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (query.error) setLastError(errMsg(query.error));
    else if (query.isSuccess && !query.isFetching) setLastError("");
  }, [query.error, query.isSuccess, query.isFetching]);
  const error = query.error ? errMsg(query.error) : query.isFetching ? lastError : "";
  const refresh = () => { void query.refetch(); void client.invalidateQueries({ queryKey: clientReadKeys.agents() }); };
  return <AppShell wide>
    <AppBar title="Agents"><Button variant="ghost" size="icon-lg" aria-label="Refresh agents" disabled={installations.isFetching || query.isFetching} onClick={refresh}><RefreshCw /></Button></AppBar>
    <ScrollArea className="flex-1" contentClassName="flex flex-col gap-4 px-4 py-4 pb-[calc(var(--banner-h)+var(--safe-bottom)+24px)]">
      {installations.error && <Alert variant="destructive">Couldn’t load agent installations. {errMsg(installations.error)}</Alert>}
      {error && <Alert variant="destructive" className="flex flex-col gap-2" aria-busy={query.isFetching}>
        <p>Couldn't load usage. {error}</p>
        {query.isFetching && <span role="status">Retrying usage…</span>}
        <Button variant="outline" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>Retry usage</Button>
      </Alert>}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {(["claude", "codex"] as const).map(agent => <AgentCard key={agent} agent={agent}
          installation={installations.data?.installations.find(item => item.agent === agent)}
          canUpdate={installations.data?.canUpdate ?? false} stale={installations.isError}
          usage={query.data ? query.data.find(item => item.agent === agent) : null} usageUnavailable={Boolean(error)} now={now} />)}
      </div>
    </ScrollArea>
  </AppShell>;
}
