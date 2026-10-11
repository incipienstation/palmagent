import { useId } from "react";
import type { RepoSettingsChange } from "@palmagent/shared";
import { RefreshCw, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { SettingsCard, SettingsField, SettingsHelp, SettingsPanel } from "./SettingsLayout";
import { useRepoSettings } from "../hooks/useRepoSettings";
import { useActionState } from "../action-state";

export function RepoSettings() {
  const id = useId();
  const { status, busy, error, notice, adding, request: mutate } = useRepoSettings();
  const [path, setPath] = useActionState("settings:repo-path", "");
  async function request(change?: RepoSettingsChange) {
    if (await mutate(change) && change?.action === "add") setPath("");
  }
  const disabled = busy || !status?.writable;

  return (
    <SettingsPanel aria-label="Repository search paths">
      {error && <Alert variant="destructive">{error}</Alert>}
      {!status && busy && <Skeleton className="h-20 w-full" aria-label="Loading search paths" />}
      <SettingsCard>
        <div className="flex min-h-14 items-center justify-between gap-3 py-1">
          <h3 className="text-sm font-medium">{status?.source === "installation" ? "Default folders" : "Search folders"}</h3>
          <Button variant="ghost" size="icon-lg" disabled={busy} aria-label="Refresh paths" title="Refresh paths" onClick={() => void request()}>
            <RefreshCw className={cn(busy && "animate-spin")} />
          </Button>
        </div>
        {status && <>
          {!status.writable && <Alert>Sign-in must be enabled to change search paths in the app. The installation owner can use the settings CLI.</Alert>}
          {status.repoRoots.length === 0 && <p className="pb-3 text-xs text-muted-foreground">Automatic search is off.</p>}
          {status.repoRoots.length > 0 && <ul className="flex flex-col">
            {status.repoRoots.map((root) => <li key={root}>
              <Separator />
              <div className="flex min-h-14 min-w-0 items-center gap-3 py-1">
                <span className="min-w-0 flex-1 break-all font-mono text-xs">{root}</span>
                <Button variant="ghost" size="icon-lg" disabled={disabled} aria-label={`Remove ${root}`}
                  onClick={() => void request({ action: "remove", paths: [root] })}><X /></Button>
              </div>
            </li>)}
          </ul>}
          {adding.map(root => <p key={root} role="status" className="break-all py-2 text-xs text-muted-foreground">{root} · Adding…</p>)}
        </>}
      </SettingsCard>
      {status && <>
        <form onSubmit={(event) => { event.preventDefault(); if (!disabled && path.trim()) void request({ action: "add", paths: [path] }); }}>
          <SettingsCard>
            <SettingsField orientation="vertical" data-disabled={disabled} data-invalid={Boolean(error)}>
              <FieldLabel variant="setting" htmlFor={`${id}-path`}>Add search folder</FieldLabel>
              <div className="flex items-center gap-2">
                <Input id={`${id}-path`} value={path} onChange={(event) => { setPath(event.target.value); }}
                  disabled={disabled} aria-invalid={Boolean(error)} placeholder="/srv/repos" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
                <Button type="submit" variant="outline" disabled={disabled || !path.trim()} aria-label="Add folder">Add</Button>
              </div>
            </SettingsField>
          </SettingsCard>
        </form>
        {status.source === "saved" && <Button variant="ghost" disabled={disabled} className="self-start"
          onClick={() => void request({ action: "reset" })}>Use installation defaults</Button>}
      </>}
      {(busy && status || notice) && <p role="status" className="text-xs text-muted-foreground">{busy && status ? "Saving or refreshing…" : notice}</p>}
      <SettingsHelp title="Search details">
        <p>Search folders apply to all devices. Removing them keeps registered Spaces.</p>
        <p>Use an absolute path or ~/ for the server user's home.</p>
      </SettingsHelp>
    </SettingsPanel>
  );
}
