import { useEffect, useId, useRef, useState } from "react";
import type { RepoSettingsChange, RepoSettingsStatus } from "@palmagent/shared";
import { X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "../api";
import { useUpdateState } from "../update-state";

export function RepoSettings() {
  const id = useId();
  const [status, setStatus] = useState<RepoSettingsStatus | null>(null);
  const [path, setPath] = useUpdateState("settings:repo-path", "");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const generation = useRef(0);

  async function request(change?: RepoSettingsChange) {
    if (pending.current) return;
    pending.current = true;
    const current = ++generation.current;
    setBusy(true); setError(""); setNotice("");
    try {
      const next = change ? await api.repoSettings.change(change) : await api.repoSettings.get();
      if (current !== generation.current) return;
      setStatus(next);
      if (change) {
        if (change.action === "add") setPath("");
        setNotice(change.action === "reset" ? "Installation defaults restored." : "Search paths saved.");
      }
    } catch (cause) {
      if (current !== generation.current) return;
      setError(cause instanceof Error ? cause.message : "Could not load search paths.");
      setStatus(null);
      // A response can fail after the write succeeds. Read actual state before
      // enabling another edit; never replay the mutation automatically.
      if (change) {
        try {
          const actual = await api.repoSettings.get();
          if (current === generation.current) setStatus(actual);
        } catch { /* Refresh is the recovery action when state is unknown. */ }
      }
    } finally {
      if (current === generation.current) { pending.current = false; setBusy(false); }
    }
  }

  useEffect(() => {
    pending.current = false;
    void request();
    const refresh = () => { if (document.visibilityState === "visible") void request(); };
    document.addEventListener("visibilitychange", refresh);
    return () => { generation.current++; document.removeEventListener("visibilitychange", refresh); };
  }, []);
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
            <Button variant="ghost" size="icon" disabled={disabled} aria-label={`Remove ${root}`}
              onClick={() => void request({ action: "remove", paths: [root] })}><X /></Button>
          </li>)}
        </ul>}
        <form onSubmit={(event) => { event.preventDefault(); if (!disabled && path.trim()) void request({ action: "add", paths: [path] }); }}>
          <FieldGroup>
            <Field data-disabled={disabled} data-invalid={Boolean(error)}>
              <FieldLabel htmlFor={`${id}-path`}>Add search folder</FieldLabel>
              <Input id={`${id}-path`} value={path} onChange={(event) => { setPath(event.target.value); setError(""); }}
                disabled={disabled} aria-invalid={Boolean(error)} placeholder="/srv/repos" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
              <FieldDescription>Use an absolute path or ~/ for the server user's home.</FieldDescription>
            </Field>
            <Button type="submit" variant="outline" disabled={disabled || !path.trim()}>Add folder</Button>
          </FieldGroup>
        </form>
      </>}
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void request()}>Refresh paths</Button>
        {status?.source === "saved" && <Button variant="ghost" size="sm" disabled={disabled}
          onClick={() => void request({ action: "reset" })}>Use installation defaults</Button>}
      </div>
      <p role="status" className="text-xs text-muted-foreground">{busy && status ? "Saving or refreshing…" : notice}</p>
    </section>
  );
}
