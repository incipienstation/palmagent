import { useId } from "react";
import { Check, RefreshCw } from "lucide-react";
import type { UpdateDiscoveryFailure, UpdateReceipt, UpdateSettingsState } from "@palmagent/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FieldLabel } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SettingsCard, SettingsField, SettingsHelp, SettingsPanel } from "./SettingsLayout";
import { useUpdateSettings } from "../hooks/useUpdateSettings";

const unavailable: Record<Exclude<UpdateSettingsState["availability"], "available">, string> = {
  "not-installed": "Update settings become available after Palmagent installation is complete.",
  "source-install": "This development build is updated through its source repository.",
  "installation-mismatch": "This server does not match the registered installation. Ask the installation owner to check setup.",
  "permission-required": "The installation owner needs to enable service-management access before these settings can be changed.",
  "authentication-required": "Sign-in must be enabled before installation settings can be changed from the app.",
  unavailable: "Update settings could not be read. Refresh status or ask the installation owner to check setup.",
};

function discoveryMessage(failure?: UpdateDiscoveryFailure): string {
  if (!failure || failure.source === "unknown") return "Could not check for updates. Check again or use the doctor plugin to investigate.";
  const source = { "codex-plugins": "Codex plugin check", "claude-plugins": "Claude plugin check", registry: "Package registry check", "release-policy": "Release compatibility check" }[failure.source];
  const reasons: Record<UpdateDiscoveryFailure["code"], string> = {
    "command-not-found": "The required command was not found in the server environment.",
    "permission-denied": "Access was denied. Check the installation owner's permissions.",
    timeout: "The check timed out. Try again.",
    "output-limit": "The command returned more data than the check could read.",
    "command-failed": "The command failed. Use the doctor plugin to inspect the installation.",
    network: "The registry could not be reached. Check the connection and try again.",
    "registry-auth": "The registry rejected authentication. Check its access settings.",
    "release-unavailable": "The selected release is not available in the registry. Try again later.",
    "invalid-response": "The response could not be read. Check the installed tools with the doctor plugin.",
    "invalid-plugin": "Installed plugin records could not be verified. Use the update plugin to repair them.",
    "incompatible-release": "The available release does not match this channel or would downgrade the application.",
    unknown: "Check again or use the doctor plugin to investigate.",
  };
  return `${source} failed. ${reasons[failure.code]}`;
}

function updateMessage(result: UpdateReceipt): string {
  if (result.status === "failed") return "The last update failed. Automatic updates are paused; use the doctor or update plugin to recover.";
  if (result.status === "applying") return `An update to ${result.targetVersion} started. Further automatic attempts wait for it to finish successfully.`;
  if (result.status === "succeeded") return result.reason === "already-current" ? "Already up to date at the last check." : `Updated to ${result.targetVersion}.`;
  const reasons: Record<string, string> = {
    "tasks-active": "Update postponed while tasks are running or waiting. It will be checked again later.",
    "idle-state-unverified": "Update postponed because Palmagent could not confirm that all tasks were idle.",
    "plugin-update-required": "This release needs a matching plugin update. Use the update plugin to continue.",
    "request-failed": "The update could not start. Check again or use the update plugin.",
    "settings-changed": "Update postponed because the update settings changed.",
  };
  return reasons[result.reason] ?? "The last update was postponed. Check the installation before retrying.";
}

export function UpdateSettings() {
  const { status, busy, saving, stale, error, action, reload, install, change } = useUpdateSettings();
  const automaticId = useId();
  const channelId = useId();
  const settings = status?.settings;
  const disabled = Boolean(action) || stale || status?.availability !== "available" || !settings;
  const last = settings?.lastUpdate;
  const discovery = settings?.discovery;
  const pending = settings?.pending;
  const checkedAt = discovery ? new Date(discovery.checkedAt) : null;
  const newer = discovery?.targetVersion && (discovery.targetVersion !== status?.currentVersion || Boolean(discovery.pluginsPending));
  const paused = last?.status === "failed" || last?.status === "applying";

  const current = Boolean(discovery && !discovery.error && !newer && !pending && !paused && last?.status !== "deferred" && !stale);
  const progress = saving ? "Saving…" : action === "install" ? "Requesting update…" : busy && status ? "Checking…" : null;

  return (
    <SettingsPanel aria-label="Updates">
      <div className="flex items-center gap-3 rounded-xl border border-border bg-background/50 p-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-xs text-muted-foreground">{stale && status ? "Last seen version" : "Current version"}</span>
          {status ? <span className="break-all text-base font-semibold" data-testid="current-version">
            {status.currentVersion ?? "Development build"}
          </span> : busy ? <Skeleton className="h-5 w-28" aria-label="Loading current version" /> : <span>Unavailable</span>}
          {settings && <div role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {current && !progress && <Check className="size-3.5" aria-hidden="true" />}
            <span>{progress ?? (paused ? last?.status === "failed" ? "Update paused" : "Updating…"
              : pending ? "Update scheduled" : last?.status === "deferred" ? "Update postponed"
              : discovery?.error ? "Check failed" : newer ? discovery.targetVersion === status?.currentVersion ? "Plugin updates available" : `Version ${discovery.targetVersion} is available.`
              : current ? "Up to date" : "Not checked yet")}</span>
          </div>}
        </div>
        <Button variant="ghost" size="icon-lg" disabled={busy} aria-label="Check again" title="Check again" onClick={() => void reload()}>
          <RefreshCw className={cn(busy && "animate-spin")} />
        </Button>
      </div>

      {error && <Alert variant="destructive">{error}</Alert>}
      {!status && busy && <Skeleton className="h-24 w-full" aria-label="Loading update settings" />}
      {status && status.availability !== "available" && <Alert>{unavailable[status.availability]}</Alert>}

      {settings && <>
        {(discovery?.error || (newer && !discovery?.eligible) || pending || paused || last?.status === "deferred") && <div className="flex flex-col gap-2 text-xs text-muted-foreground" role="status">
          {discovery?.error && <Alert variant="warning">{discoveryMessage(discovery.failure)}</Alert>}
          {newer && !discovery?.eligible && <Alert>This release needs a matching operator plugin. Use the update plugin to continue.</Alert>}
          {pending && !paused && <p>{settings.independentExecutions ? `Preparing update to ${pending.targetVersion}. Your agent runs continue.` : `Update to ${pending.targetVersion} is scheduled. It will start after active tasks finish.`}</p>}
          {last && (paused || last.status === "deferred") && <Alert variant={last.status === "failed" ? "warning" : "default"}>{updateMessage(last)}</Alert>}
        </div>}
        {newer && discovery?.eligible && !settings.autoUpdate && <Button disabled={disabled || busy || Boolean(pending) || paused}
          onClick={() => void install(discovery.targetVersion!)}>{last?.status === "applying" ? "Updating…" : pending ? "Update scheduled" : "Update"}</Button>}

        <SettingsCard>
          <SettingsField data-disabled={disabled}>
            <FieldLabel variant="setting" htmlFor={automaticId}>Automatic updates</FieldLabel>
            <Switch id={automaticId} checked={settings.autoUpdate} disabled={disabled} aria-busy={saving}
              onCheckedChange={(autoUpdate) => void change({ autoUpdate })} />
          </SettingsField>
          <Separator />
          <SettingsField data-disabled={disabled} className="flex-wrap">
            <FieldLabel variant="setting" id={channelId}>Channel</FieldLabel>
            <ToggleGroup variant="outline" type="single" className="w-auto" aria-labelledby={channelId} value={settings.channel} disabled={disabled} aria-busy={saving}
              onValueChange={(channel) => { if (channel === "stable" || channel === "preview") void change({ channel }); }}>
              <ToggleGroupItem value="stable" className="px-3">Stable</ToggleGroupItem>
              <ToggleGroupItem value="preview" className="px-3">Preview</ToggleGroupItem>
            </ToggleGroup>
          </SettingsField>
        </SettingsCard>

        <SettingsHelp title="Update details">
          {last?.pluginActivationPending && <p>Last update included plugins. New agent sessions use the updated plugins.</p>}
          <p>{settings.independentExecutions ? "Automatic updates run when you open the app. Agent runs continue." : "Automatic updates run when you open the app, after active tasks finish."}</p>
          <p>Stable uses stable releases. Preview includes alpha, beta, and release candidates. Changing channel does not install or downgrade immediately.</p>
          {checkedAt && Number.isFinite(checkedAt.getTime()) && <p>Last checked: <time dateTime={discovery!.checkedAt}>{checkedAt.toLocaleString()}</time></p>}
        </SettingsHelp>
      </>}
    </SettingsPanel>
  );
}
