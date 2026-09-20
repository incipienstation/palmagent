import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Plus, Terminal as TerminalIcon, Trash2, Pencil, Check } from "lucide-react";
import type { TerminalCapabilities, TerminalSession } from "@palmagent/shared/terminals";
import { api } from "../api";
import { useRepos } from "../hooks/useRepos";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Alert } from "./ui/alert";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "./ui/alert-dialog";
import { AppBar } from "./AppShell";
import { TerminalScreen } from "./TerminalScreen";
import { useUpdateState } from "../update-state";

export function TerminalsView({ taskId, repoId, onClose }: { taskId?: string; repoId?: string; onClose?: () => void }) {
  const { repos } = useRepos();
  const scope = "terminals:" + (taskId ?? repoId ?? "all");
  const [space, setSpace] = useUpdateState(scope + ":space", repoId ?? "");
  const [terminals, setTerminals] = useState<TerminalSession[]>([]);
  const [capabilities, setCapabilities] = useState<TerminalCapabilities>();
  const [selected, setSelected] = useUpdateState(scope + ":selected", "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [renaming, setRenaming] = useUpdateState(scope + ":renaming", false);
  const [title, setTitle] = useUpdateState(scope + ":title", "");
  const requestId = useRef<string | undefined>(undefined);
  const generation = useRef(0);
  useEffect(() => { requestId.current = undefined; }, [space, taskId]);
  const refresh = useCallback(async () => {
    const currentGeneration = generation.current;
    const result = await api.terminals.list(taskId ? { taskId } : space ? { repoId: space } : {});
    if (generation.current !== currentGeneration) return;
    setTerminals(result.terminals); setCapabilities(result.capabilities);
    setSelected(current => result.terminals.some(t => t.id === current) ? current : result.terminals.find(t => t.state === "running")?.id ?? result.terminals[0]?.id ?? "");
  }, [taskId, space]);
  useEffect(() => {
    let live = true;
    const load = () => { if (document.visibilityState !== "hidden") void refresh().catch(e => { if (live) setError(e.message); }); };
    load(); const timer = setInterval(load, 5000);
    return () => { live = false; generation.current++; clearInterval(timer); };
  }, [refresh]);
  const active = terminals.find(t => t.id === selected);
  async function act(operation: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await operation(); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "Terminal action failed"); }
    finally { setBusy(false); }
  }
  const create = () => act(async () => {
    if (!taskId && !space) return;
    requestId.current ??= crypto.randomUUID();
    const result = await api.terminals.create({ target: taskId ? { taskId } : { repoId: space }, requestId: requestId.current, cols: 80, rows: 24 });
    setSelected(result.terminal.id); requestId.current = undefined;
  });
  return <section className="flex h-app min-w-0 flex-1 flex-col bg-background" aria-label="Terminals">
    {onClose ? <header className="flex shrink-0 items-center gap-2 px-3 pt-[calc(10px+var(--safe-top))] pb-2">
      <Button variant="ghost" size="icon-lg" aria-label="Back to conversation" onClick={onClose}><ArrowLeft /></Button>
      <h2 className="text-base font-semibold">Terminals</h2>
    </header> : <AppBar title="Terminals" back />}
    <div className="flex shrink-0 flex-col gap-2 px-3 pb-2">
      {!taskId && <Select value={space} onValueChange={value => { setSpace(value); setSelected(""); }} disabled={busy}>
        <SelectTrigger aria-label="Terminal space"><SelectValue placeholder="Choose a Space" /></SelectTrigger>
        <SelectContent><SelectGroup>{[...repos.values()].map(repo => <SelectItem key={repo.id} value={repo.id}>{repo.name}</SelectItem>)}</SelectGroup></SelectContent>
      </Select>}
      <div className="flex min-w-0 gap-2">
        <Select value={selected} onValueChange={value => { setSelected(value); setRenaming(false); }} disabled={!terminals.length || busy}>
          <SelectTrigger className="min-w-0 flex-1" aria-label="Select terminal"><SelectValue placeholder="No terminal yet" /></SelectTrigger>
          <SelectContent><SelectGroup>{terminals.map(t => <SelectItem key={t.id} value={t.id}>{t.title} · {t.state}</SelectItem>)}</SelectGroup></SelectContent>
        </Select>
        <Button variant="outline" size="icon-lg" aria-label="New terminal" disabled={busy || !capabilities?.available || (!taskId && !space)} onClick={() => void create()}><Plus /></Button>
        {active && <Button variant="ghost" size="icon-lg" aria-label="Rename terminal" disabled={busy} onClick={() => { setTitle(active.title); setRenaming(true); }}><Pencil /></Button>}
        {active && ["starting", "running", "closing"].includes(active.state) && <Button variant="ghost" size="icon-lg" aria-label="Terminate terminal" disabled={busy} onClick={() => setConfirm(true)}><Trash2 /></Button>}
      </div>
      {renaming && active && <form className="flex gap-2" onSubmit={event => { event.preventDefault(); void act(async () => { await api.terminals.rename(active.id, title); setRenaming(false); }); }}>
        <Input aria-label="Terminal name" value={title} onChange={e => setTitle(e.target.value)} maxLength={80} autoFocus />
        <Button size="icon-lg" aria-label="Save terminal name" disabled={busy || !title.trim()}><Check /></Button>
      </form>}
      {busy && <p role="status" className="text-xs text-muted-foreground">Updating terminal…</p>}
      {error && <Alert variant="destructive">{error}</Alert>}
      {capabilities && !capabilities.available && <Alert>{capabilities.reason ?? "Terminals are unavailable on this platform."}</Alert>}
      {active && <p className="truncate text-xs text-muted-foreground" title={active.initialCwd}>Started in {active.initialCwd}</p>}
    </div>
    {active?.state === "running" ? <TerminalScreen key={active.id} id={active.id} />
      : <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-5 text-center text-muted-foreground">
        <TerminalIcon aria-hidden="true" />
        <p>{active ? active.state === "starting" ? "Starting shell…" : active.state === "closing" ? "Closing shell…" : active.state === "lost" ? "This shell stopped unexpectedly. Open a new terminal to continue." : "Shell exited" + (active.exitCode !== undefined ? " · " + active.exitCode : "") : "Open a terminal to work in this directory."}</p>
        {!active && <p className="text-sm">Terminals keep running when you leave this screen.</p>}
      </div>}
    <AlertDialog open={confirm} onOpenChange={setConfirm}>
      <AlertDialogContent><AlertDialogHeader>
        <AlertDialogTitle>Terminate this terminal?</AlertDialogTitle>
        <AlertDialogDescription>This ends the shell and its child processes. To leave them running, return to the conversation instead.</AlertDialogDescription>
      </AlertDialogHeader><AlertDialogFooter>
        <AlertDialogCancel>Keep running</AlertDialogCancel>
        <AlertDialogAction onClick={() => { setConfirm(false); if (active) void act(() => api.terminals.terminate(active.id)); }}>Terminate</AlertDialogAction>
      </AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </section>;
}
