import Database from "better-sqlite3";
import type { AgentKind, Permission, Routine, RoutineRun } from "@palmagent/shared";

type RoutineRow = {
  kind: string; script_json: string | null;
  id: string; repo_id: string; agent: string; title: string | null; prompt: string;
  permission: string; model: string | null; effort: string | null; preset: string; schedule: string; enabled: number;
  last_run_at: number | null; next_run_at: number | null; created_at: number; updated_at: number;
};

type RoutineRunRow = {
  result_json: string | null;
  id: number; routine_id: string; fired_at: number; status: string; task_id: string | null; note: string | null;
};

function rowToRoutine(r: RoutineRow): Routine {
  return {
    kind: r.kind as Routine["kind"],
    script: r.script_json ? JSON.parse(r.script_json) : undefined,
    id: r.id,
    repoId: r.repo_id,
    agent: r.agent as AgentKind,
    title: r.title ?? undefined,
    prompt: r.prompt,
    permission: r.permission as Permission,
    model: r.model ?? undefined,
    effort: r.effort ?? undefined,
    preset: (r.preset ?? "custom") as Routine["preset"],
    schedule: r.schedule,
    enabled: r.enabled === 1,
    lastRunAt: r.last_run_at ?? undefined,
    nextRunAt: r.next_run_at ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToRoutineRun(r: RoutineRunRow): RoutineRun {
  return {
    ...(r.result_json ? JSON.parse(r.result_json) : {}),
    id: r.id,
    routineId: r.routine_id,
    firedAt: r.fired_at,
    status: r.status as RoutineRun["status"],
    taskId: r.task_id ?? undefined,
    note: r.note ?? undefined,
  };
}

function routineToRow(r: Routine) {
  return {
    kind: r.kind ?? "agent",
    script_json: r.script ? JSON.stringify(r.script) : null,
    id: r.id,
    repo_id: r.repoId,
    agent: r.agent,
    title: r.title ?? null,
    prompt: r.prompt,
    permission: r.permission,
    model: r.model ?? null,
    effort: r.effort ?? null,
    preset: r.preset,
    schedule: r.schedule,
    enabled: r.enabled ? 1 : 0,
    last_run_at: r.lastRunAt ?? null,
    next_run_at: r.nextRunAt ?? null,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

export class SqliteRoutines {
constructor(private readonly db: Database.Database) {}
insertRoutine(r: Routine) {
    this.db.prepare(
      `INSERT INTO routines (kind, script_json, id, repo_id, agent, title, prompt, permission, model, effort, preset, schedule,
         enabled, last_run_at, next_run_at, created_at, updated_at)
       VALUES (@kind, @script_json, @id, @repo_id, @agent, @title, @prompt, @permission, @model, @effort, @preset, @schedule,
         @enabled, @last_run_at, @next_run_at, @created_at, @updated_at)`,
    ).run(routineToRow(r));
  }

updateRoutine(r: Routine) {
    this.db.prepare(
      `UPDATE routines SET kind=@kind, script_json=@script_json, repo_id=@repo_id, agent=@agent, title=@title, prompt=@prompt,
         permission=@permission, model=@model, effort=@effort, preset=@preset, schedule=@schedule, enabled=@enabled,
         last_run_at=@last_run_at, next_run_at=@next_run_at, updated_at=@updated_at
       WHERE id=@id`,
    ).run(routineToRow(r));
  }

deleteRoutine(id: string) {
    this.db.transaction((rid: string) => {
      this.db.prepare(`DELETE FROM routine_runs WHERE routine_id = ?`).run(rid);
      this.db.prepare(`DELETE FROM routines WHERE id = ?`).run(rid);
    })(id);
  }

getRoutine(id: string): Routine | undefined {
    const row = this.db.prepare(`SELECT * FROM routines WHERE id = ?`).get(id) as RoutineRow | undefined;
    return row && rowToRoutine(row);
  }

listRoutines(): Routine[] {
    return (this.db.prepare(`SELECT * FROM routines ORDER BY created_at`).all() as RoutineRow[]).map(rowToRoutine);
  }

insertRoutineRun(run: Omit<RoutineRun, "id">): number {
    const result = this.db.prepare(
      `INSERT INTO routine_runs (routine_id, fired_at, status, task_id, note, result_json)
       VALUES (@routine_id, @fired_at, @status, @task_id, @note, @result_json)`,
    ).run({
      routine_id: run.routineId,
      fired_at: run.firedAt,
      status: run.status,
      task_id: run.taskId ?? null,
      note: run.note ?? null,
      result_json: run.reason ? JSON.stringify({ reason: run.reason }) : null,
    });
    return Number(result.lastInsertRowid);
  }

finishRoutineRun(id: number, result: Pick<RoutineRun, "status" | "note" | "finishedAt" | "exitCode" | "output" | "worktreePath">) {
    this.db.prepare("UPDATE routine_runs SET status = ?, note = ?, result_json = ? WHERE id = ?")
      .run(result.status, result.note ?? null, JSON.stringify(result), id);
  }

hasRunningRoutine(repoId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM routine_runs rr JOIN routines r ON r.id = rr.routine_id WHERE r.repo_id = ? AND rr.status = 'running' LIMIT 1").get(repoId);
  }

interruptRoutineRuns() {
    this.db.prepare("UPDATE routine_runs SET status = 'interrupted', note = 'server stopped before completion was recorded' WHERE status = 'running'").run();
  }

listRoutineRuns(routineId: string, limit = 20): RoutineRun[] {
    return (
      this.db
        .prepare(`SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY fired_at DESC, id DESC LIMIT ?`)
        .all(routineId, limit) as RoutineRunRow[]
    ).map(rowToRoutineRun);
  }
}
