import { useEffect, useId, useRef, useState } from "react";
import type { Repo } from "@palmagent/shared";
import { useSpaceOperations } from "../hooks/remote-operations";
import { useRepos } from "../hooks/useRepos";
import { cacheSession } from "../query-lifecycle";
import { queryClient } from "../query-client";
import { clientReadKeys } from "../client-query-keys";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { Skeleton } from "./ui/skeleton";

function BaseBranchForm({ repo }: { repo: Repo }) {
  const id = useId();
  const operations = useSpaceOperations();
  const [value, setValue] = useState(repo.defaultBaseRef);
  const previousBase = useRef(repo.defaultBaseRef);
  useEffect(() => {
    const previous = previousBase.current;
    setValue(current => current === previous ? repo.defaultBaseRef : current);
    previousBase.current = repo.defaultBaseRef;
  }, [repo.defaultBaseRef]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function save() {
    if (busy || !value.trim()) return;
    const generation = cacheSession();
    setBusy(true); setError(""); setNotice("");
    try {
      const actual = await operations.update(repo.id, value.trim());
      if (generation !== cacheSession()) return;
      queryClient.setQueryData<Repo[]>(clientReadKeys.repos(), current => current?.map(item => item.id === actual.id ? actual : item));
      setValue(actual.defaultBaseRef);
      setNotice("Saved. Future isolated tasks and routine runs will use this base branch.");
    } catch (e) {
      if (generation === cacheSession()) setError(e instanceof Error ? e.message : "Could not save base branch.");
    } finally { setBusy(false); }
  }
  return <form aria-label={`Base branch for ${repo.name}`} className="flex min-w-0 flex-col gap-3 border-b py-4 last:border-b-0"
    onSubmit={event => { event.preventDefault(); void save(); }}>
    <div className="flex min-w-0 flex-col gap-1">
      <h3 className="text-sm font-medium">{repo.name}</h3>
      <p className="break-all text-xs text-muted-foreground">{repo.path}</p>
    </div>
    <FieldGroup>
      <Field data-invalid={!!error} data-disabled={busy}>
        <FieldLabel htmlFor={id}>Base branch</FieldLabel>
        <Input id={id} value={value} disabled={busy} aria-invalid={!!error} aria-describedby={`${id}-help`}
          onChange={event => { setValue(event.target.value); setError(""); setNotice(""); }}
          autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <FieldDescription id={`${id}-help`}>Use a locally available branch or Git ref, such as main or origin/develop.</FieldDescription>
      </Field>
      <Button type="submit" variant="outline" disabled={busy || !value.trim() || value.trim() === repo.defaultBaseRef}>
        {busy ? "Saving…" : "Save base branch"}
      </Button>
    </FieldGroup>
    {error && <Alert variant="destructive">{error}</Alert>}
    {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
  </form>;
}

export function SpaceSettings() {
  const { repos, loading, error, refresh, refreshing } = useRepos();
  const gitRepos = [...repos.values()].filter(repo => repo.vcs !== "none");
  return <section className="flex flex-col gap-3 py-4" aria-label="Space base branches">
    <p className="text-sm text-muted-foreground">Choose where new isolated tasks and routine runs start. Existing tasks and your current checkout stay unchanged. Branches are not fetched automatically.</p>
    {loading && <Skeleton className="h-24 w-full" aria-label="Loading spaces" />}
    {error && <><Alert variant="destructive">{error}</Alert><Button variant="outline" disabled={refreshing} onClick={() => void refresh().catch(() => {})}>Retry</Button></>}
    {!loading && !error && gitRepos.length === 0 && <p className="text-sm text-muted-foreground">No Git spaces registered. Plain folders do not have a base branch.</p>}
    {gitRepos.map(repo => <BaseBranchForm key={repo.id} repo={repo} />)}
  </section>;
}
