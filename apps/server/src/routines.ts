import { CreateRoutineSchema, UpdateRoutineSchema } from "@palmagent/shared/requests";
import { runRoutineScript } from "./routine-script.js";
import { randomBytes } from "node:crypto";
import type {
  CreateRoutineRequest, Routine, RoutinePreset, RoutineRun, UpdateRoutineRequest,
} from "@palmagent/shared";
import { DEFAULT_PERMISSION } from "@palmagent/shared";
import { nextRun, parseCron, presetToCron } from "./cron.js";
import type { Db } from "./db.js";
import { HttpError, type TaskService } from "./service.js";

// Routines: recurring agent tasks or scripts. Agent fires create a fresh task;
// script fires run directly and record their result in routine history. A cadence is
// chosen as a friendly preset (hourly/daily/weekly/weekdays) that compiles to
// cron, "manual" (no schedule — run-now only), or "custom" (raw cron). Missed
// runs while the server was down are skipped — on boot we recompute next_run_at
// from "now" instead of firing a backlog stampede, and log a "skipped" run so
// the gap is visible in the routine's history (no catch-up run).

const TICK_MS = 15_000;

export class RoutineService {
  private timer?: NodeJS.Timeout;
  private scripts = new Map<string, ReturnType<typeof runRoutineScript>>();
  private stopping = false;

  constructor(
    private readonly db: Db,
    private readonly tasks: TaskService,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.db.interruptRoutineRuns();
    const now = Date.now();
    for (const r of this.db.listRoutines()) {
      if (!r.enabled || r.preset === "manual" || !r.schedule) continue;
      if (!r.nextRunAt || r.nextRunAt <= now) {
        const skipped = !!r.nextRunAt && r.nextRunAt <= now;
        r.nextRunAt = nextRun(r.schedule, now);
        r.updatedAt = now;
        this.db.updateRoutine(r);
        if (skipped) {
          // Record-only (no catch-up): make the missed fire visible in history.
          this.db.insertRoutineRun({ routineId: r.id, firedAt: now, status: "skipped", note: "missed while the server was down" });
          console.log(`[routines] ${r.id} missed a run while down — skipped to next`);
        }
      }
    }
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const run of this.scripts.values()) run.stop();
    await Promise.all([...this.scripts.values()].map(run => run.done));
  }

  private tick(): void {
    if (this.tasks.updating) return;
    const now = Date.now();
    for (const r of this.db.listRoutines()) {
      if (!r.enabled || !r.nextRunAt || r.nextRunAt > now) continue;
      this.fire(r, now);
    }
  }

  // Execute the template. `manual` = a run-now (does not advance
  // the schedule); a scheduled fire advances next_run_at. Every fire is recorded
  // in the routine's run history.
  private fire(r: Routine, now: number, manual = false): void {
    if (r.kind === "script") {
      if (this.stopping || this.tasks.updating) throw new HttpError(503, "Palmagent is restarting");
      if (this.scripts.has(r.id) || this.scripts.size >= 4) {
        if (manual) throw new HttpError(409, "A script is already running or all four script slots are busy");
        this.db.insertRoutineRun({ routineId: r.id, firedAt: now, status: "skipped", note: "script already running or script capacity reached" });
      } else {
        const runId = this.db.insertRoutineRun({ routineId: r.id, firedAt: now, status: "running", note: manual ? "manual" : "scheduled" });
        const execution = runRoutineScript(this.db, r, runId);
        this.scripts.set(r.id, execution);
        void execution.done.finally(() => this.scripts.delete(r.id));
      }
      r.lastRunAt = now;
      if (!manual) r.nextRunAt = r.schedule ? nextRun(r.schedule, now) : undefined;
      r.updatedAt = now;
      this.db.updateRoutine(r);
      return;
    }
    let taskId: string | undefined;
    let note: string | undefined;
    try {
      const task = this.tasks.createTask({
        repoId: r.repoId,
        agent: r.agent,
        prompt: r.prompt,
        permission: r.permission,
        model: r.model,
        effort: r.effort,
        // Routines are unattended + recurring, so they always run in their own
        // isolated worktree (a separate space from the user's working copy) — never
        // in place, where a scheduled fire could collide with manual work. Ignored
        // for plain folders (vcs "none"), which have no worktree mechanism.
        isolate: true,
        title: r.title ? `⏱ ${r.title}` : `⏱ routine ${r.id}`,
      });
      taskId = task.taskId;
    } catch (e) {
      note = e instanceof Error ? e.message : String(e);
      console.error(`[routines] ${r.id} failed to dispatch: ${String(e)}`);
    }
    this.db.insertRoutineRun({ routineId: r.id, firedAt: now, status: manual ? "manual" : "fired", taskId, note });
    r.lastRunAt = now;
    // A run-now leaves the cadence untouched; a scheduled fire advances it.
    if (!manual) r.nextRunAt = r.schedule ? nextRun(r.schedule, now) : undefined;
    r.updatedAt = now;
    this.db.updateRoutine(r);
  }

  // ---- CRUD (REST layer calls these) ----
  create(req: CreateRoutineRequest): Routine {
    const parsed = CreateRoutineSchema.safeParse(req);
    if (!parsed.success) throw new HttpError(400, parsed.error.message);
    req = parsed.data;
    if (!this.db.getRepo(req.repoId)) throw new HttpError(400, `no such repo: ${req.repoId}`);

    const preset: RoutinePreset = req.preset ?? "custom";
    const now = Date.now();
    const { schedule, nextRunAt } = this.compile(preset, req, now);
    const routine: Routine = {
      id: "rt" + randomBytes(4).toString("hex"),
      repoId: req.repoId,
      kind: req.kind ?? "agent",
      script: req.script ? { ...req.script, timeoutSeconds: req.script.timeoutSeconds ?? 300 } : undefined,
      agent: req.agent ?? "claude",
      title: req.title,
      prompt: req.prompt ?? "",
      permission: req.permission ?? DEFAULT_PERMISSION[req.agent ?? "claude"],
      model: req.model,
      effort: req.effort,
      preset,
      schedule,
      enabled: req.enabled ?? true,
      nextRunAt: req.enabled === false ? undefined : nextRunAt,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insertRoutine(routine);
    return routine;
  }

  // Resolve a preset + its parameters into the stored cron + the first fire time.
  // manual → no schedule, never auto-fires; custom → the raw cron (validated);
  // friendly presets → compiled cron.
  private compile(
    preset: RoutinePreset,
    src: { schedule?: string; hour?: number; dayOfWeek?: number },
    now: number,
  ): { schedule: string; nextRunAt?: number } {
    if (preset === "manual") return { schedule: "", nextRunAt: undefined };
    if (preset === "custom") {
      validateCron(src.schedule);
      return { schedule: src.schedule!, nextRunAt: nextRun(src.schedule!, now) };
    }
    const cron = presetToCron(preset, src.hour, src.dayOfWeek);
    if (!cron) throw new HttpError(400, `unknown preset: ${preset}`);
    return { schedule: cron, nextRunAt: nextRun(cron, now) };
  }

  context() {
    return { repos: this.db.listRepos(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }

  list(): Routine[] {
    return this.db.listRoutines();
  }

  get(id: string): Routine {
    const r = this.db.getRoutine(id);
    if (!r) throw new HttpError(404, `no such routine: ${id}`);
    return r;
  }

  update(id: string, req: UpdateRoutineRequest): Routine {
    const r = this.get(id);
    const parsed = UpdateRoutineSchema.safeParse(req);
    if (!parsed.success) throw new HttpError(400, parsed.error.message);
    req = parsed.data;
    if (r.kind === "script" && [req.prompt, req.permission, req.model, req.effort].some(field => field !== undefined)) {
      throw new HttpError(400, "Script routines do not accept agent settings");
    }
    if (req.script && r.kind !== "script") throw new HttpError(400, "Only script routines accept script settings");
    if (req.script) r.script = { ...req.script, timeoutSeconds: req.script.timeoutSeconds ?? r.script?.timeoutSeconds ?? 300 };
    const now = Date.now();
    // Recompile the cadence when any cadence field is present in the patch.
    const cadenceChanged =
      req.preset !== undefined || req.schedule !== undefined ||
      req.hour !== undefined || req.dayOfWeek !== undefined;
    if (cadenceChanged) {
      const preset = req.preset ?? r.preset;
      const fields = r.schedule.split(/\s+/);
      const existingNumber = (field?: string) => field && /^\d+$/.test(field) ? Number(field) : undefined;
      const { schedule } = this.compile(preset, { schedule: req.schedule ?? r.schedule,
        hour: req.hour ?? existingNumber(fields[1]), dayOfWeek: req.dayOfWeek ?? existingNumber(fields[4]) }, now);
      r.preset = preset;
      r.schedule = schedule;
    }
    if (req.prompt !== undefined) {
      if (!req.prompt) throw new HttpError(400, "prompt cannot be empty");
      r.prompt = req.prompt;
    }
    if (req.title !== undefined) r.title = req.title || undefined;
    if (req.permission !== undefined) r.permission = req.permission;
    if (req.model !== undefined) r.model = req.model || undefined;
    if (req.effort !== undefined) r.effort = req.effort || undefined;
    if (req.enabled !== undefined) r.enabled = req.enabled;
    // Re-derive the next fire from now; a manual or disabled routine never fires.
    r.nextRunAt = r.enabled && r.preset !== "manual" && r.schedule ? nextRun(r.schedule, now) : undefined;
    r.updatedAt = now;
    this.db.updateRoutine(r);
    return r;
  }

  remove(id: string): Routine {
    if (this.scripts.has(id)) throw new HttpError(409, "Wait for the running script before deleting this routine");
    const r = this.get(id);
    this.db.deleteRoutine(id);
    return r;
  }

  runNow(id: string): Routine {
    const r = this.get(id);
    this.fire(r, Date.now(), true); // manual: record + dispatch, leave the cadence alone
    return this.get(id);
  }

  async stopRun(id: string): Promise<Routine> {
    const r = this.get(id);
    if (r.kind !== "script") throw new HttpError(400, "Stop agent runs from their task");
    const execution = this.scripts.get(id);
    execution?.stop("interrupted by user");
    await execution?.done;
    return this.get(id);
  }

  runs(id: string, limit = 20): RoutineRun[] {
    this.get(id); // 404 if the routine doesn't exist
    return this.db.listRoutineRuns(id, limit);
  }
}

function validateCron(expr: string | undefined): void {
  if (!expr) throw new HttpError(400, "schedule (cron) is required");
  try {
    parseCron(expr);
  } catch (e) {
    throw new HttpError(400, `invalid cron: ${e instanceof Error ? e.message : String(e)}`);
  }
}
