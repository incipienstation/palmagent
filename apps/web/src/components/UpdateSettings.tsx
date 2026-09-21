import { useId } from "react";
import type { UpdateReceipt, UpdateSettingsState } from "@palmagent/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useUpdateSettings } from "../hooks/useUpdateSettings";

const unavailable: Record<Exclude<UpdateSettingsState["availability"], "available">, string> = {
  "not-installed": "Update settings become available after Palmagent installation is complete.",
  "source-install": "This development build is updated through its source repository.",
  "installation-mismatch": "This server does not match the registered installation. Ask the installation owner to check setup.",
  "permission-required": "The installation owner needs to enable service-management access before these settings can be changed.",
  "authentication-required": "Sign-in must be enabled before installation settings can be changed from the app.",
  unavailable: "Update settings could not be read. Refresh status or ask the installation owner to check setup.",
};

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

  return (
    <section aria-label="Updates" className="flex flex-col gap-3 py-3">
      <p className="text-xs text-muted-foreground">Keep Palmagent up to date across your devices.</p>
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-muted-foreground">{stale && status ? "Last seen version" : "Current version"}</span>
        {status ? <span className="break-all text-right font-medium text-foreground" data-testid="current-version">
          {status.currentVersion ?? "Development build"}
        </span> : busy ? <Skeleton className="h-4 w-28" aria-label="Loading current version" /> : <span>Unavailable</span>}
      </div>

      {error && <Alert variant="destructive">{error}</Alert>}
      {!status && busy && <Skeleton className="h-24 w-full" aria-label="Loading update settings" />}
      {status && status.availability !== "available" && <Alert>{unavailable[status.availability]}</Alert>}

      {settings && <FieldGroup className="gap-3">
        <Field orientation="horizontal" data-disabled={disabled}>
          <FieldContent className="gap-1">
            <FieldLabel htmlFor={automaticId}>Automatic updates</FieldLabel>
            <FieldDescription className="text-xs">{settings.independentExecutions ? "Checks when you open the app and updates automatically. Agent runs continue." : "Checks when you open the app and updates after active tasks finish."}</FieldDescription>
          </FieldContent>
          <Switch id={automaticId} checked={settings.autoUpdate} disabled={disabled} aria-busy={saving}
            onCheckedChange={(autoUpdate) => void change({ autoUpdate })} />
        </Field>
        <Field orientation="horizontal" data-disabled={disabled} className="flex-wrap">
          <FieldLabel id={channelId}>Release channel</FieldLabel>
          <ToggleGroup type="single" className="w-auto" aria-labelledby={channelId} value={settings.channel} disabled={disabled} aria-busy={saving}
            onValueChange={(channel) => { if (channel === "stable" || channel === "preview") void change({ channel }); }}>
            <ToggleGroupItem value="stable" className="px-3">Stable</ToggleGroupItem>
            <ToggleGroupItem value="preview" className="px-3">Preview</ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <p className="text-xs text-muted-foreground">
          {settings.channel === "preview" ? "Preview includes alpha, beta, and release candidates." : "Stable follows stable releases only."}
          {" "}Changing channel does not install or downgrade immediately.
        </p>
        <div className="flex flex-col gap-2 text-xs text-muted-foreground" role="status">
          {discovery?.error ? <Alert variant="warning">Could not check for updates. Try again when connected.</Alert>
            : newer ? <p>{discovery.targetVersion === status?.currentVersion ? "Operator plugin updates are available." : `Version ${discovery.targetVersion} is available.`}</p>
            : discovery ? <p>You are up to date.</p> : <p>No update checks yet.</p>}
          {newer && !discovery?.eligible && <Alert>This release needs a matching operator plugin. Use the update plugin to continue.</Alert>}
          {pending && !paused && <p>{settings.independentExecutions ? `Preparing update to ${pending.targetVersion}. Your agent runs continue.` : `Update to ${pending.targetVersion} is scheduled. It will start after active tasks finish.`}</p>}
          {last && (paused || last.status === "deferred") && <p>{updateMessage(last)}</p>}
          {last?.pluginActivationPending && <p>Operator plugins were updated. Start a new agent session to load the new skills.</p>}
          {checkedAt && Number.isFinite(checkedAt.getTime()) && <p>Last checked: <time dateTime={discovery!.checkedAt}>{checkedAt.toLocaleString()}</time></p>}
        </div>
      </FieldGroup>}
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground" role="status">{saving ? "Saving…" : action === "install" ? "Requesting update…" : busy && status ? "Checking for updates…" : ""}</span>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={() => void reload()}>Check again</Button>
          {newer && discovery?.eligible && !settings?.autoUpdate && <Button disabled={disabled || busy || Boolean(pending) || paused}
            onClick={() => void install(discovery.targetVersion!)}>{last?.status === "applying" ? "Updating…" : pending ? "Update scheduled" : "Update"}</Button>}
        </div>
      </div>
    </section>
  );
}
