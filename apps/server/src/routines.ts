import { randomBytes } from "node:crypto";
import type {
  CreateRoutineRequest, Routine, RoutinePreset, RoutineRun, UpdateRoutineRequest,
} from "@palmagent/shared";
import { DEFAULT_PERMISSION } from "@palmagent/shared";
import { nextRun, parseCron, presetToCron } from "./cron.js";
import type { Db } from "./db.js";
import { HttpError, type TaskService } from "./service.js";

// Routines: cron-scheduled recurring dispatch. Every fire creates a FRESH
// task from the routine template (it does not resume a session). A cadence is
// chosen as a friendly preset (hourly/daily/weekly/weekdays) that compiles to
// cron, "manual" (no schedule — run-now only), or "custom" (raw cron). Missed
// runs while the server was down are skipped — on boot we recompute next_run_at
// from "now" instead of firing a backlog stampede, and log a "skipped" run so
// the gap is visible in the routine's history (no catch-up run).

const TICK_MS = 15_000;

export class RoutineService {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: Db,
    private readonly tasks: TaskService,
  ) {}

  start(): void {
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

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private tick(): void {
    const now = Date.now();
    for (const r of this.db.listRoutines()) {
      if (!r.enabled || !r.nextRunAt || r.nextRunAt > now) continue;
      this.fire(r, now);
    }
  }

  // Dispatch one task from the template. `manual` = a run-now (does not advance
  // the schedule); a scheduled fire advances next_run_at. Every fire is recorded
  // in the routine's run history.
  private fire(r: Routine, now: number, manual = false): void {
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
    if (req?.agent !== "claude" && req?.agent !== "codex") {
      throw new HttpError(400, "agent must be 'claude' or 'codex'");
    }
    if (!req.prompt) throw new HttpError(400, "prompt is required");
    if (!this.db.getRepo(req.repoId)) throw new HttpError(400, `no such repo: ${req.repoId}`);

    const preset: RoutinePreset = req.preset ?? "custom";
    const now = Date.now();
    const { schedule, nextRunAt } = this.compile(preset, req, now);
    const routine: Routine = {
      id: "rt" + randomBytes(4).toString("hex"),
      repoId: req.repoId,
      agent: req.agent,
      title: req.title,
      prompt: req.prompt,
      permission: req.permission ?? DEFAULT_PERMISSION[req.agent],
      model: req.model,
      effort: req.effort,
      preset,
      schedule,
      enabled: true,
      nextRunAt,
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
    const now = Date.now();
    // Recompile the cadence when any cadence field is present in the patch.
    const cadenceChanged =
      req.preset !== undefined || req.schedule !== undefined ||
      req.hour !== undefined || req.dayOfWeek !== undefined;
    if (cadenceChanged) {
      const preset = req.preset ?? r.preset;
      const { schedule } = this.compile(preset, { schedule: req.schedule ?? r.schedule, hour: req.hour, dayOfWeek: req.dayOfWeek }, now);
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
    const r = this.get(id);
    this.db.deleteRoutine(id);
    return r;
  }

  runNow(id: string): Routine {
    const r = this.get(id);
    this.fire(r, Date.now(), true); // manual: record + dispatch, leave the cadence alone
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
