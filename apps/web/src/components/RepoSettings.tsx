import { useId } from "react";
import type { RepoSettingsChange } from "@palmagent/shared";
import { X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
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
    <section className="flex flex-col gap-3 py-4" aria-labelledby={id}>
      <h3 id={id} className="text-[15px] font-medium">Space search paths</h3>
      <p className="text-xs text-muted-foreground">Folders on the server to search for Git repositories. Changes apply to all devices without a restart.</p>
      {error && <Alert variant="destructive">{error}</Alert>}
      {!status && busy && <Skeleton className="h-20 w-full" aria-label="Loading search paths" />}
      {status && <>
        {!status.writable && <Alert>Sign-in must be enabled to change search paths in the app. The installation owner can use the settings CLI.</Alert>}
        <p className="text-xs text-muted-foreground">
          {status.source === "installation" ? "Using installation defaults." : "Using saved search paths."}
          {status.repoRoots.length === 0 && " Automatic search is off. Registered spaces are kept."}
        </p>
        {status.repoRoots.length > 0 && <ul className="flex flex-col gap-2">
          {status.repoRoots.map((root) => <li key={root} className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 break-all font-mono text-xs">{root}</span>
            <Button variant="ghost" size="icon-lg" disabled={disabled} aria-label={`Remove ${root}`}
              onClick={() => void request({ action: "remove", paths: [root] })}><X /></Button>
          </li>)}
        </ul>}
        {adding.map(root => <p key={root} role="status" className="break-all text-xs text-muted-foreground">{root} · Adding…</p>)}
        <form onSubmit={(event) => { event.preventDefault(); if (!disabled && path.trim()) void request({ action: "add", paths: [path] }); }}>
          <FieldGroup>
            <Field data-disabled={disabled} data-invalid={Boolean(error)}>
              <FieldLabel htmlFor={`${id}-path`}>Add search folder</FieldLabel>
              <Input id={`${id}-path`} value={path} onChange={(event) => { setPath(event.target.value); }}
                disabled={disabled} aria-invalid={Boolean(error)} placeholder="/srv/repos" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
              <FieldDescription>Use an absolute path or ~/ for the server user's home.</FieldDescription>
            </Field>
            <Button type="submit" variant="outline" disabled={disabled || !path.trim()}>Add folder</Button>
          </FieldGroup>
        </form>
      </>}
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" disabled={busy} onClick={() => void request()}>Refresh paths</Button>
        {status?.source === "saved" && <Button variant="ghost" disabled={disabled}
          onClick={() => void request({ action: "reset" })}>Use installation defaults</Button>}
      </div>
      <p role="status" className="text-xs text-muted-foreground">{busy && status ? "Saving or refreshing…" : notice}</p>
    </section>
  );
}
