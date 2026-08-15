import { useEffect, useState, type FormEvent } from "react";
import type { AgentKind, Permission, Repo, Routine, RoutinePreset, RoutineRun } from "@palmagent/shared";
import { CalendarClock, ChevronRight, MoreVertical, Play, Plus, Trash2, X } from "lucide-react";

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
import { api, ApiError, DEFAULT_OPTION, DEFAULT_PERMISSION, EFFORTS, MODELS, PERMISSIONS } from "../api";
import { usePersistedMapEntry } from "../hooks/useDraft";
import { navigate } from "../router";
import { AppBar, AppShell } from "./AppShell";
import { AgentTag } from "./chips";
import { EmptyState } from "./EmptyState";

// Routines: recurring dispatch on a friendly cadence (preset → cron) or
// manual run-now. Each fire creates a fresh task from the template (visible in
// the inbox like any other task) and is recorded in the routine's run history.

const AGENTS: AgentKind[] = ["claude", "codex"];
const PRESETS: RoutinePreset[] = ["hourly", "daily", "weekly", "weekdays", "manual", "custom"];
const PRESET_LABEL: Record<RoutinePreset, string> = {
  hourly: "Hourly", daily: "Daily", weekly: "Weekly", weekdays: "Weekdays", manual: "Manual", custom: "Custom",
};
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hhmm = (h: number) => `${String(h).padStart(2, "0")}:00`;
const RUN_LABEL: Record<RoutineRun["status"], string> = {
  fired: "Ran on schedule", manual: "Ran (manual)", skipped: "Skipped (server was down)",
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

function RoutineCard({ r, busy, onToggle, onRun, onDelete }: {
  r: Routine;
  busy: boolean;
  onToggle: () => void;
  onRun: () => void;
  onDelete: () => void;
}) {
  const [history, setHistory] = useState<RoutineRun[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  async function toggleHistory() {
    const next = !showHistory;
    setShowHistory(next);
    if (next && history === null) {
      try {
        setHistory(await api.routineRuns(r.id));
      } catch {
        setHistory([]); // best-effort; an empty list reads as "nothing yet"
      }
    }
  }

  return (
    <Card>
      <CardContent className="p-4 pb-0">
        <div className="flex items-start gap-3">
          <span className="min-w-0 flex-1 truncate text-[15px] leading-5 font-semibold text-strong">
            {r.title?.trim() || r.prompt.split("\n")[0]}
          </span>
          <Switch
            checked={r.enabled}
            onCheckedChange={onToggle}
            disabled={busy}
            aria-label="Enabled"
          />
        </div>
        <p className="mt-1.5 line-clamp-2 text-[13px] leading-5 text-muted-foreground">{r.prompt}</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <AgentTag agent={r.agent} />
          {r.preset === "custom" ? (
            <span className="font-mono text-[12.5px] text-faint">{r.schedule}</span>
          ) : (
            <span className="text-[12.5px] text-faint">{scheduleLabel(r)}</span>
          )}
          {r.preset !== "manual" && (
            <span className="text-[12.5px] text-faint">next {fmtNext(r.nextRunAt)}</span>
          )}
          {r.lastRunAt && (
            <span className="text-[12.5px] text-faint">last {fmtTime(r.lastRunAt)}</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void toggleHistory()}
          className="mt-2.5 text-[12.5px] font-medium text-primary"
        >
          {showHistory ? "Hide history" : "History"}
        </button>
        {showHistory && (
          <div className="mt-2 space-y-1.5 border-t border-border pt-2.5">
            {history === null ? (
              <span className="text-[12.5px] text-faint">Loading…</span>
            ) : history.length === 0 ? (
              <span className="text-[12.5px] text-faint">No runs yet.</span>
            ) : (
              history.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  disabled={!run.taskId}
                  onClick={() => run.taskId && navigate(`/task/${encodeURIComponent(run.taskId)}`)}
                  className="flex w-full items-center gap-2 text-left text-[12.5px] disabled:cursor-default"
                >
                  <span
                    className={
                      "size-1.5 shrink-0 rounded-full " +
                      (run.status === "skipped" ? "bg-amber-500" : "bg-emerald-500")
                    }
                  />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{RUN_LABEL[run.status]}</span>
                  <span className="shrink-0 text-faint">{fmtTime(run.firedAt)}</span>
                  {run.taskId && <ChevronRight className="size-3.5 shrink-0 text-faint" />}
                </button>
              ))
            )}
          </div>
        )}
      </CardContent>
      <CardFooter className="mt-3 p-4 pt-0">
        <Button
          variant="secondary"
          className="flex-1"
          disabled={busy}
          onClick={onRun}
        >
          <Play className="size-4" /> Run now
        </Button>
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
                    inbox. This can't be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogAction disabled={busy} onClick={onDelete}>
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
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);

  // create-form state
  const [repoId, setRepoId] = useState("");
  const [agent, setAgent] = useState<AgentKind>("claude");
  // Model/effort/permission are remembered PER AGENT across form opens, on keys
  // separate from the dispatch form's — a routine's unattended settings are a
  // distinct intent from an ad-hoc dispatch, so they don't cross-contaminate.
  const [permission, setPermission] = usePersistedMapEntry<Permission>("pref:routine-permission", agent, DEFAULT_PERMISSION[agent]);
  const [model, setModel] = usePersistedMapEntry<string>("pref:routine-model", agent, DEFAULT_OPTION);
  const [effort, setEffort] = usePersistedMapEntry<string>("pref:routine-effort", agent, DEFAULT_OPTION);
  const [preset, setPreset] = useState<RoutinePreset>("daily");
  const [hour, setHour] = useState(9);
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [cron, setCron] = useState("0 9 * * *"); // only used when preset === "custom"
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");

  async function reload() {
    try {
      const [rts, rps] = await Promise.all([api.listRoutines(), api.listRepos()]);
      setRoutines(rts);
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

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await reload();
    } catch (e) {
      const msg = errMsg(e);
      setError(msg);
      toast({ title: "Something went wrong", description: msg, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!repoId) return setError("Register a repo first (from the dispatch form).");
    if (!prompt.trim()) return setError("Enter a prompt.");
    const hasTime = preset === "daily" || preset === "weekly" || preset === "weekdays";
    await act(async () => {
      await api.createRoutine({
        repoId,
        agent,
        prompt: prompt.trim(),
        preset,
        ...(preset === "custom" ? { schedule: cron.trim() } : {}),
        ...(hasTime ? { hour } : {}),
        ...(preset === "weekly" ? { dayOfWeek } : {}),
        permission,
        ...(model !== DEFAULT_OPTION ? { model } : {}),
        ...(effort !== DEFAULT_OPTION ? { effort } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
      });
      // Clear the one-shot fields only — model/effort/permission persist per
      // agent so the next routine re-opens with the same settings.
      setPrompt("");
      setTitle("");
      setPreset("daily");
      setShowForm(false);
      toast({ title: "Routine created", variant: "success" });
    });
  }

  const loading = routines === null;
  const isEmpty = routines !== null && routines.length === 0;

  return (
    <AppShell>
      <AppBar title="Routines" brand settings />
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 pb-[calc(var(--tabbar-h)+var(--banner-h)+24px)]">
        {error && <Alert variant="destructive">{error}</Alert>}

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
            subtitle="Schedule a recurring dispatch and it'll fire a fresh task on your cadence."
            action={{ label: "New routine", onClick: () => setShowForm(true) }}
          />
        )}

        {routines?.map((r) => (
          <RoutineCard
            key={r.id}
            r={r}
            busy={busy}
            onToggle={() => void act(() => api.updateRoutine(r.id, { enabled: !r.enabled }))}
            onRun={() => void act(() => api.runRoutine(r.id))}
            onDelete={() => void act(() => api.deleteRoutine(r.id))}
          />
        ))}

        {showForm ? (
          <Card>
            <form className="flex flex-col gap-5 p-4" onSubmit={create}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold tracking-wide text-faint uppercase">
                  New routine
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="-mr-1.5 text-faint"
                  onClick={() => setShowForm(false)}
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
                  <Label>Model</Label>
                  <Select value={model} onValueChange={(v) => v && setModel(v)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MODELS[agent].map((m) => (
                        <SelectItem key={m.value} value={m.value}>
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Label>Effort</Label>
                  <Select value={effort} onValueChange={(v) => v && setEffort(v)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {EFFORTS[agent].map((eo) => (
                        <SelectItem key={eo.value} value={eo.value}>
                          {eo.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

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

              <div className="space-y-1.5">
                <Label htmlFor="routine-prompt">Prompt</Label>
                <Textarea
                  id="routine-prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={4}
                  placeholder="What should run on this schedule?"
                />
              </div>

              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? "…" : "Create routine"}
              </Button>
            </form>
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
