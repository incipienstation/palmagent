import { reloadRoutines, useRoutines } from "../hooks/useRoutines";
import { useForegroundRefresh } from "../hooks/useForegroundRefresh";
import { useActionState } from "../action-state";
import { useEffect, useState, type FormEvent } from "react";
import type { AgentKind, Permission, Repo, Routine, RoutinePreset, RoutineRun } from "@palmagent/shared";
import { CalendarClock, ChevronRight, MoreVertical, Play, Plus, Trash2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Alert } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { toast } from "@/components/ui/toaster";
import { api, ApiError, DEFAULT_OPTION, DEFAULT_PERMISSION, PERMISSIONS } from "../api";
import { effortChoices, selectableEffort, selectableModel, useAgentCatalog } from "../model-catalog";
import { useDraft, clearDraft, usePersistedMapEntry } from "../hooks/useDraft";
import { navigate } from "../router";
import { AppBar, AppShell } from "./AppShell";
import { AgentTag } from "./chips";
import { EmptyState } from "./EmptyState";

// Routines: recurring agent tasks or scripts, with shared cadence and history.

const AGENTS: AgentKind[] = ["claude", "codex"];
const PRESETS: RoutinePreset[] = ["hourly", "daily", "weekly", "weekdays", "manual", "custom"];
const PRESET_LABEL: Record<RoutinePreset, string> = {
  hourly: "Hourly", daily: "Daily", weekly: "Weekly", weekdays: "Weekdays", manual: "Manual", custom: "Custom",
};
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hhmm = (h: number) => `${String(h).padStart(2, "0")}:00`;
const RUN_LABEL: Record<RoutineRun["status"], string> = {
  fired: "Ran on schedule", manual: "Ran (manual)", skipped: "Skipped",
  running: "Script running", succeeded: "Script succeeded", failed: "Failed", interrupted: "Interrupted",
};

// Friendly one-line cadence for a routine card. Custom routines show their raw
// cron; preset routines read the hour/dow back out of the compiled cron.
function scheduleLabel(r: Routine): string {
  const f = r.schedule.split(/\s+/);
  const h = Number(f[1]);
  const time = Number.isInteger(h) ? hhmm(h) : r.schedule;
  switch (r.preset) {
    case "manual": return "Manual";
    case "hourly": return "Hourly";
    case "custom": return r.schedule;
    case "daily": return `Daily at ${time}`;
    case "weekdays": return `Weekdays at ${time}`;
    case "weekly": return `Weekly on ${DOW[Number(f[4])] ?? "?"} at ${time}`;
  }
}

function errMsg(e: unknown): string {
  return e instanceof ApiError || e instanceof Error ? e.message : String(e);
}

// Absolute wall-clock label for last-run (and, on faraway dates, next-run).
function fmtTime(ms?: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? hm : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${hm}`;
}

// Humanized "next: in 3h" for the schedule line. Falls back to the absolute
// time once it's more than a day out (where "in 30h" reads worse than a date).
function fmtNext(ms?: number): string {
  if (!ms) return "—";
  const diff = ms - Date.now();
  if (diff <= 0) return "due now";
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "in <1m";
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  return fmtTime(ms);
}

function RoutineCard({ r, busy, saving, stale, onToggle, onRun, onStop, onDelete }: {
  r: Routine;
  busy: boolean;
  saving: boolean;
  stale: boolean;
  onToggle: () => void;
  onRun: () => void;
  onStop: () => void;
  onDelete: () => void;
}) {
  const [history, setHistory] = useState<RoutineRun[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyAttempt, setHistoryAttempt] = useState(0);

  useEffect(() => {
    if (!showHistory || !history?.some(run => run.status === "running")) return;
    const timer = setInterval(() => setHistoryAttempt(value => value + 1), 3000);
    return () => clearInterval(timer);
  }, [showHistory, history]);

  const loadHistory = () => setHistoryAttempt(value => value + 1);
  useForegroundRefresh(() => { if (showHistory) loadHistory(); });
  useEffect(() => {
    if (!showHistory) return;
    let active = true;
    setHistoryLoading(true); setHistoryError("");
    void api.routineRuns(r.id, r.kind === "script")
      .then(value => { if (active) setHistory(value); })
      .catch(error => { if (active) setHistoryError(errMsg(error)); })
      .finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; };
  }, [showHistory, r.id, r.kind, r.updatedAt, r.lastRunAt, historyAttempt]);

  function toggleHistory() { setShowHistory(value => !value); }

  return (
    <Card>
      <CardContent className="p-4 pb-0">
        <div className="flex items-start gap-3">
          <span className="min-w-0 flex-1 truncate text-[15px] leading-5 font-semibold text-strong">
            {r.title?.trim() || (r.script?.command ?? r.prompt).split("\n")[0]}
          </span>
          <Switch
            checked={r.enabled}
            aria-busy={saving}
            onCheckedChange={onToggle}
            disabled={busy || stale}
            aria-label="Enabled"
          />
        </div>
        <p className="mt-1.5 line-clamp-2 text-[13px] leading-5 text-muted-foreground">{r.script?.command ?? r.prompt}</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          {r.kind === "script" ? <Badge variant="secondary">Script</Badge> : <AgentTag agent={r.agent} />}
          {r.preset === "custom" ? (
            <span className="font-mono text-[12.5px] text-faint">{r.schedule}</span>
          ) : (
            <span className="text-[12.5px] text-faint">{scheduleLabel(r)}</span>
          )}
          {r.preset !== "manual" && (
            <span className="text-[12.5px] text-faint">{saving ? "Saving schedule…" : stale ? "Refresh to check schedule" : `next ${fmtNext(r.nextRunAt)}`}</span>
          )}
          {r.lastRunAt && (
            <span className="text-[12.5px] text-faint">last {fmtTime(r.lastRunAt)}</span>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          onClick={() => void toggleHistory()}
          aria-expanded={showHistory}
          className="mt-1 -ml-3"
        >
          {showHistory ? "Hide history" : "History"}
        </Button>
        {showHistory && (
          <div className="mt-2 flex flex-col gap-1.5 border-t border-border pt-2.5" aria-busy={historyLoading}>
            {historyError && <Alert variant="destructive" className="flex flex-col gap-2">
              <p>Couldn't load history. {historyError}</p>
              <Button variant="outline" disabled={historyLoading} onClick={() => void loadHistory()}>Retry history</Button>
            </Alert>}
            {historyLoading && <span role="status" className="text-[12.5px] text-faint">Loading history…</span>}
            {history !== null && (history.length === 0 ? (
              <span className="text-[12.5px] text-faint">No runs yet.</span>
            ) : (
              history.map((run) => (
                <div key={run.id} className="min-w-0">
                  <button
                    type="button"
                    disabled={!run.taskId}
                    onClick={() => run.taskId && navigate(`/task/${encodeURIComponent(run.taskId)}`)}
                    className="flex min-h-11 w-full items-center gap-2 text-left text-[12.5px] disabled:cursor-default"
                  >
                    <span
                      className={
                        "size-1.5 shrink-0 rounded-full " +
                        (["failed", "interrupted"].includes(run.status) ? "bg-destructive" : "bg-muted-foreground")
                      }
                    />
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{run.status === "skipped" && run.note === "missed while the server was down" ? "Skipped (server was down)" : RUN_LABEL[run.status]}</span>
                    <span className="shrink-0 text-faint">{fmtTime(run.firedAt)}</span>
                    {run.taskId && <ChevronRight className="size-3.5 shrink-0 text-faint" />}
                  </button>
                  {run.note && <p className="break-words text-xs text-muted-foreground">{run.note}</p>}
                  {run.exitCode !== undefined && <p className="text-xs text-muted-foreground">Exit code: {run.exitCode}</p>}
                  {run.worktreePath && <p className="break-all text-xs text-muted-foreground">Files: {run.worktreePath}</p>}
                  {run.output && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs">{run.output}</pre>}
                </div>
              ))
            ))}
          </div>
        )}
      </CardContent>
      <CardFooter className="mt-3 p-4 pt-0">
        <Button
          variant="secondary"
          className="flex-1"
          disabled={busy || saving || stale}
          onClick={onRun}
        >
          <Play className="size-4" /> {busy ? "Requesting run…" : "Run now"}
        </Button>
        {r.kind === "script" && <Button variant="secondary" disabled={busy || saving || stale} onClick={onStop}>Stop script</Button>}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="icon" className="size-11 text-faint" aria-label="More">
              <MoreVertical className="size-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {/* Destructive confirm: a routine delete is irreversible. The trigger
                keeps the accessible name "Delete routine"; the same REST call
                fires only on confirm. */}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <DropdownMenuItem
                  variant="destructive"
                  aria-label="Delete routine"
                  // Keep the menu's close-on-select from racing the dialog open.
                  onSelect={(e) => e.preventDefault()}
                >
                  <Trash2 /> Delete routine
                </DropdownMenuItem>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this routine?</AlertDialogTitle>
                  <AlertDialogDescription>
                    It will stop firing on its schedule. Tasks it already created stay in your
                    inbox. Script files stay on disk. This can't be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogAction disabled={busy || saving} onClick={onDelete}>
                    Delete routine
                  </AlertDialogAction>
                  <AlertDialogCancel>Keep</AlertDialogCancel>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardFooter>
    </Card>
  );
}

export function RoutinesView() {
  const { routines, actions, saving, stale, creating, error: mutationError, toggle, run, stop, remove, create: createRoutine } = useRoutines();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [error, setError] = useState("");
  const busy = creating !== null;
  const [showForm, setShowForm] = useActionState(`routine:showForm`, false);

  const [kind, setKind] = useActionState<"agent" | "script">("routine:kind", "agent");
  const [command, setCommand] = useDraft("routine:command");
  const [timeoutSeconds, setTimeoutSeconds] = useActionState("routine:timeout", 300);

  // create-form state
  const [repoId, setRepoId] = useActionState(`routine:repoId`, "");
  const [agent, setAgent] = useActionState<AgentKind>(`routine:agent`, "claude");
  // Model/effort/permission are remembered PER AGENT across form opens, on keys
  // separate from the dispatch form's — a routine's unattended settings are a
  // distinct intent from an ad-hoc dispatch, so they don't cross-contaminate.
  const [permission, setPermission] = usePersistedMapEntry<Permission>("pref:routine-permission", agent, DEFAULT_PERMISSION[agent]);
  const [savedModel, saveModel] = usePersistedMapEntry<string>("pref:routine-model", agent, DEFAULT_OPTION);
  const [savedEffort, setEffort] = usePersistedMapEntry<string>("pref:routine-effort", agent, DEFAULT_OPTION);
  const catalog = useAgentCatalog(agent);
  const model = selectableModel(catalog, savedModel);
  const effort = selectableEffort(catalog, model, savedEffort);
  function setModel(value: string) {
    saveModel(value);
    setEffort(selectableEffort(catalog, value, effort));
  }
  const [preset, setPreset] = useActionState<RoutinePreset>(`routine:preset`, "daily");
  const [hour, setHour] = useActionState(`routine:hour`, 9);
  const [dayOfWeek, setDayOfWeek] = useActionState(`routine:dayOfWeek`, 1);
  const [cron, setCron] = useActionState(`routine:cron`, "0 9 * * *"); // only used when preset === "custom"
  const [title, setTitle] = useDraft(`routine:title`);
  const [prompt, setPrompt] = useDraft(`routine:prompt`);

  async function reload() {
    try {
      const [, rps] = await Promise.all([reloadRoutines(), api.listRepos()]);
      setRepos(rps);
      setRepoId((cur) => (cur && rps.some((r) => r.id === cur) ? cur : (rps[0]?.id ?? "")));
    } catch (e) {
      setError(errMsg(e));
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useForegroundRefresh(() => { void reload(); });

  async function create(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!repoId) return setError("Register a repo first (from the dispatch form).");
    if (kind === "agent" && !prompt.trim()) return setError("Enter a prompt.");
    if (kind === "script" && !command.trim()) return setError("Enter a script command.");
    const hasTime = preset === "daily" || preset === "weekly" || preset === "weekdays";
    const created = await createRoutine({
        repoId,
        ...(kind === "script" ? { kind, script: { command: command.trim(), timeoutSeconds } }
          : { kind, agent, prompt: prompt.trim(), permission,
            ...(model !== DEFAULT_OPTION ? { model } : {}), ...(effort !== DEFAULT_OPTION ? { effort } : {}) }),
        preset,
        ...(preset === "custom" ? { schedule: cron.trim() } : {}),
        ...(hasTime ? { hour } : {}),
        ...(preset === "weekly" ? { dayOfWeek } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
      });
    if (created) {
      // Clear the one-shot fields only — model/effort/permission persist per
      // agent so the next routine re-opens with the same settings.
      clearDraft("routine:title", kind === "script" ? "routine:command" : "routine:prompt");
      if (kind === "script") setCommand(""); else setPrompt("");
      setTitle("");
      setPreset("daily");
      setShowForm(false);
      toast({ title: "Routine created", variant: "success" });
    }
  }

  const loading = routines === null;
  const isEmpty = routines !== null && routines.length === 0;

  return (
    <AppShell>
      <AppBar title="Routines" />
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 pb-[calc(var(--banner-h)+var(--safe-bottom)+24px)]">
        {(error || mutationError) && <Alert variant="destructive">{error || mutationError}</Alert>}
        {creating !== null && <Card role="status" className="p-4"><p className="truncate font-medium">{creating}</p><p className="text-sm text-muted-foreground">Creating routine…</p></Card>}
        {[...actions].some(([, action]) => action === "delete") && <p role="status" className="text-sm text-muted-foreground">Deleting routine…</p>}

        {loading && (
          <>
            <Skeleton className="h-[148px] w-full rounded-xl" />
            <Skeleton className="h-[148px] w-full rounded-xl" />
          </>
        )}

        {isEmpty && !showForm && (
          <EmptyState
            icon={CalendarClock}
            title="No routines yet"
            subtitle="Schedule an agent task or a script to run on your cadence."
            action={{ label: "New routine", onClick: () => setShowForm(true) }}
          />
        )}

        {routines?.map((r) => (
          <RoutineCard
            key={r.id}
            r={r}
            busy={actions.has(r.id)} saving={saving.has(r.id)} stale={stale.has(r.id)}
            onToggle={() => toggle(r)}
            onRun={() => void run(r.id)}
            onStop={() => void stop(r.id)}
            onDelete={() => void remove(r.id)}
          />
        ))}

        {showForm ? (
          <Card>
            <form className="relative flex flex-col gap-5 p-4" onSubmit={create}><fieldset disabled={busy} className="flex min-w-0 flex-col gap-5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold tracking-wide text-faint uppercase">
                  New routine
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="-mr-1.5 text-faint"
                  disabled={busy} onClick={() => setShowForm(false)}
                  aria-label="Close"
                >
                  <X className="size-5" />
                </Button>
              </div>

              <div className="space-y-1.5">
                <Label>Repo</Label>
                {/* "" guard: see DispatchForm — Radix's form-bridge select can echo
                    a stale "" when value + items arrive in the same render. */}
                <Select
                  value={repoId}
                  onValueChange={(v) => v && setRepoId(v)}
                  disabled={repos.length === 0}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={repos.length === 0 ? "no repos registered" : "select a repo"}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {repos.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}{" "}
                        <span className="text-muted-foreground">
                          ({r.vcs === "none" ? "folder" : r.defaultBaseRef})
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Field>
                <FieldLabel>Run type</FieldLabel>
                <ToggleGroup type="single" value={kind} onValueChange={value => value && setKind(value as "agent" | "script")} aria-label="Run type">
                  <ToggleGroupItem value="agent">Agent task</ToggleGroupItem>
                  <ToggleGroupItem value="script">Script</ToggleGroupItem>
                </ToggleGroup>
              </Field>
              {kind === "agent" && <>
              <div className="space-y-1.5">
                <Label>Agent</Label>
                {/* Model + effort + permission are remembered per agent, so
                    switching just changes the agent — each agent's last choices
                    come back with it (option sets differ, so none leaks across). */}
                <ToggleGroup
                  type="single"
                  value={agent}
                  onValueChange={(v) => v && setAgent(v as AgentKind)}
                >
                  {AGENTS.map((a) => (
                    <ToggleGroupItem key={a} value={a}>
                      {a}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>

              <div className="space-y-1.5">
                <Label>Permission</Label>
                <Select value={permission} onValueChange={(v) => v && setPermission(v)}>
                  <SelectTrigger aria-label="Permission">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-w-[min(20rem,calc(100vw-1.25rem))]">
                    {PERMISSIONS[agent].map((p) => (
                      <SelectItem key={p.value} value={p.value} textValue={p.label} description={p.description}>
                        <span className={p.danger ? "text-destructive" : undefined}>{p.label}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex gap-2.5">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Label htmlFor="routine-model">Model</Label>
                  <Select value={model} onValueChange={(v) => v && setModel(v)}>
                    <SelectTrigger id="routine-model">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {catalog.models.map((m) => (
                        <SelectItem key={m.value} value={m.value}>
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Label htmlFor="routine-effort">Effort</Label>
                  <Select value={effort} onValueChange={(v) => v && setEffort(v)}>
                    <SelectTrigger id="routine-effort">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {effortChoices(catalog, model, effort).map((eo) => (
                        <SelectItem key={eo.value} value={eo.value}>
                          {eo.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              </>}
              <Separator />

              <div className="space-y-1.5">
                <Label>Schedule</Label>
                <Select value={preset} onValueChange={(v) => v && setPreset(v as RoutinePreset)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRESETS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {PRESET_LABEL[p]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {(preset === "daily" || preset === "weekly" || preset === "weekdays") && (
                  <div className="flex gap-2.5 pt-1">
                    {preset === "weekly" && (
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <Label>Day</Label>
                        <Select value={String(dayOfWeek)} onValueChange={(v) => v && setDayOfWeek(Number(v))}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {DOW.map((d, i) => (
                              <SelectItem key={d} value={String(i)}>
                                {d}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <Label>Time</Label>
                      <Select value={String(hour)} onValueChange={(v) => v && setHour(Number(v))}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Array.from({ length: 24 }, (_, h) => (
                            <SelectItem key={h} value={String(h)}>
                              {hhmm(h)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}

                {preset === "custom" && (
                  <Input
                    className="mt-1 font-mono"
                    value={cron}
                    onChange={(e) => setCron(e.target.value)}
                    placeholder="0 9 * * *"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-label="Cron (m h dom mon dow)"
                  />
                )}

                {preset === "manual" && (
                  <p className="text-[12.5px] text-faint">
                    Won't run on a schedule — fires only when you tap “Run now”.
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="routine-title">Title (optional)</Label>
                <Input
                  id="routine-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="short label"
                />
              </div>

              {kind === "script" ? <>
                <Field>
                  <FieldLabel htmlFor="routine-command">Script command</FieldLabel>
                  <Textarea id="routine-command" value={command} onChange={event => setCommand(event.target.value)} rows={5}
                    className="font-mono" autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="node scripts/report.mjs" />
                  <FieldDescription>Runs as the server account using /bin/sh. Git spaces use an isolated worktree; plain folders run in place. Generated files are retained.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="routine-timeout">Timeout (seconds)</FieldLabel>
                  <Input id="routine-timeout" type="number" min={1} max={3600} required value={timeoutSeconds}
                    onChange={event => setTimeoutSeconds(Number(event.target.value))} />
                </Field>
              </> : <div className="space-y-1.5">
                <Label htmlFor="routine-prompt">Prompt</Label>
                <Textarea
                  id="routine-prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={4}
                  placeholder="What should run on this schedule?"
                />
              </div>}

              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? "…" : "Create routine"}
              </Button>
            </fieldset></form>
          </Card>
        ) : (
          // Only the EmptyState CTA shows when there are no routines yet, so
          // gate this bottom toggle on a non-empty list to avoid two
          // simultaneous "New routine" buttons.
          !loading && !isEmpty && (
            <Button variant="secondary" onClick={() => setShowForm(true)}>
              <Plus /> New routine
            </Button>
          )
        )}
      </div>
    </AppShell>
  );
}
