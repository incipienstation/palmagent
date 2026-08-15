import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AgentEvent, AgentKind, AgentUsage, Permission, PrRef, PushSubscriptionJson, QuestionRequest, Repo, Routine, RoutineRun, TaskState, TaskStatus,
} from "@palmagent/shared";
import { makePrRef } from "@palmagent/shared";

// SQLite holds metadata + the append-only event log only. Resume still reads the
// CLIs' local transcripts — there is no external session store. The event log
// backs SSE replay (Last-Event-ID): `events.id` is the global monotonic id and
// `events.seq` is per-task monotonic (for scoped streams).

export interface EventRow {
  id: number; // global, AUTOINCREMENT — SSE id on the inbox stream
  seq: number; // per-task monotonic — SSE id on a scoped stream
  event: AgentEvent;
}

type RepoRow = {
  id: string; name: string; path: string; vcs: string; default_base_ref: string; created_at: number;
};
type TaskRow = {
  id: string; repo_id: string; agent: string; title: string | null; prompt: string;
  status: string; interrupted: number; session_id: string | null; branch: string | null;
  worktree_path: string | null; permission: string; model: string | null; effort: string | null;
  pr_url: string | null; pr_urls: string | null; pending_input: string | null;
  created_at: number; updated_at: number; last_activity_at: number;
};
type RoutineRow = {
  id: string; repo_id: string; agent: string; title: string | null; prompt: string;
  permission: string; model: string | null; effort: string | null; preset: string; schedule: string; enabled: number;
  last_run_at: number | null; next_run_at: number | null; created_at: number; updated_at: number;
};
type RoutineRunRow = {
  id: number; routine_id: string; fired_at: number; status: string; task_id: string | null; note: string | null;
};
type EventJoinRow = {
  id: number; seq: number; task_id: string; kind: string; payload_json: string; ts: number;
  agent: string; session_id: string | null;
};

export class Db {
  private db: Database.Database;
  // Prepared in the constructor (after the schema exists), not as field
  // initializers — those run before `this.db` is assigned.
  private insertEventStmt!: Database.Statement;
  private getSeqStmt!: Database.Statement;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    this.insertEventStmt = this.db.prepare(
      `INSERT INTO events (task_id, seq, kind, payload_json, ts)
       VALUES (?, (SELECT COALESCE(MAX(seq),0)+1 FROM events WHERE task_id = ?), ?, ?, ?)`,
    );
    this.getSeqStmt = this.db.prepare(`SELECT seq FROM events WHERE id = ?`);
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        default_base_ref TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES repos(id),
        agent TEXT NOT NULL,
        title TEXT,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        interrupted INTEGER NOT NULL DEFAULT 0,
        session_id TEXT,
        branch TEXT,
        worktree_path TEXT,
        permission TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_task_seq ON events(task_id, seq);
      CREATE TABLE IF NOT EXISTS approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        event_id INTEGER,
        request_json TEXT,
        decision TEXT,
        decided_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS push_subs (
        endpoint TEXT PRIMARY KEY,
        subscription_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS routines (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES repos(id),
        agent TEXT NOT NULL,
        title TEXT,
        prompt TEXT NOT NULL,
        permission TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        preset TEXT NOT NULL DEFAULT 'custom',
        schedule TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at INTEGER,
        next_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      -- Run history: one row per fire / run-now / skipped-while-down (no catch-up).
      CREATE TABLE IF NOT EXISTS routine_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        routine_id TEXT NOT NULL,
        fired_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        task_id TEXT,
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_routine_runs ON routine_runs(routine_id, fired_at);
      -- In-app WebAuthn auth. One logical
      -- user, N passkeys (one row per device). Sessions are opaque random tokens;
      -- enroll_tokens are short-lived, host-CLI-minted, single-use registration grants.
      CREATE TABLE IF NOT EXISTS webauthn_credentials (
        credential_id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        counter INTEGER NOT NULL,
        transports TEXT,
        label TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        label TEXT
      );
      CREATE TABLE IF NOT EXISTS enroll_tokens (
        token TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
    `);
    // Additive migration for databases created before PR references were persisted.
    const taskCols = (this.db.pragma("table_info(tasks)") as { name: string }[]).map((c) => c.name);
    if (!taskCols.includes("pr_url")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN pr_url TEXT`);
    }
    // Additive migration for the per-dispatch reasoning-effort selector.
    if (!taskCols.includes("effort")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN effort TEXT`);
    }
    // Additive migration for the runner-daemon reattach high-water-mark: the
    // last stdout line seq durably persisted for the active turn.
    if (!taskCols.includes("last_raw_seq")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN last_raw_seq INTEGER NOT NULL DEFAULT 0`);
    }
    // Additive migration for AskUserQuestion: the unanswered question (JSON) the
    // task is paused on while awaiting_input. NULL when there's nothing pending.
    if (!taskCols.includes("pending_input")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN pending_input TEXT`);
    }
    // Additive migration for multiple PRs per task: the full PrRef[] (JSON). The
    // legacy single pr_url column stays (kept = prs[0].url); pre-existing rows
    // synthesize their prs from it in rowToTask until the next PR event rewrites it.
    if (!taskCols.includes("pr_urls")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN pr_urls TEXT`);
    }
    const routineCols = (this.db.pragma("table_info(routines)") as { name: string }[]).map((c) => c.name);
    if (!routineCols.includes("effort")) {
      this.db.exec(`ALTER TABLE routines ADD COLUMN effort TEXT`);
    }
    // Additive migration for friendly schedule presets (every pre-existing row is
    // a raw-cron routine, i.e. "custom").
    if (!routineCols.includes("preset")) {
      this.db.exec(`ALTER TABLE routines ADD COLUMN preset TEXT NOT NULL DEFAULT 'custom'`);
    }
    // Additive migration for plain-folder repos (every pre-existing row is git).
    const repoCols = (this.db.pragma("table_info(repos)") as { name: string }[]).map((c) => c.name);
    if (!repoCols.includes("vcs")) {
      this.db.exec(`ALTER TABLE repos ADD COLUMN vcs TEXT NOT NULL DEFAULT 'git'`);
    }
  }

  // ---- repos ----
  insertRepo(r: Repo) {
    this.db.prepare(
      `INSERT INTO repos (id, name, path, vcs, default_base_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(r.id, r.name, r.path, r.vcs, r.defaultBaseRef, r.createdAt);
  }
  getRepo(id: string): Repo | undefined {
    const row = this.db.prepare(`SELECT * FROM repos WHERE id = ?`).get(id) as RepoRow | undefined;
    return row && rowToRepo(row);
  }
  listRepos(): Repo[] {
    return (this.db.prepare(`SELECT * FROM repos ORDER BY created_at`).all() as RepoRow[]).map(rowToRepo);
  }
  deleteRepo(id: string) {
    // Cascade by hand: tasks/routines carry a FK to repos(id), and events/
    // approvals key off task_id (no declared FK). Archived tasks legitimately
    // still reference the repo, so a bare DELETE FROM repos trips
    // SQLITE_CONSTRAINT_FOREIGNKEY. Tear it all down in one transaction.
    // (Worktrees of archived tasks were already removed at archive time.)
    this.db.transaction((repoId: string) => {
      const taskIds = (
        this.db.prepare(`SELECT id FROM tasks WHERE repo_id = ?`).all(repoId) as { id: string }[]
      ).map((r) => r.id);
      const delEvents = this.db.prepare(`DELETE FROM events WHERE task_id = ?`);
      const delApprovals = this.db.prepare(`DELETE FROM approvals WHERE task_id = ?`);
      for (const tid of taskIds) {
        delEvents.run(tid);
        delApprovals.run(tid);
      }
      this.db.prepare(`DELETE FROM tasks WHERE repo_id = ?`).run(repoId);
      const routineIds = (
        this.db.prepare(`SELECT id FROM routines WHERE repo_id = ?`).all(repoId) as { id: string }[]
      ).map((r) => r.id);
      const delRuns = this.db.prepare(`DELETE FROM routine_runs WHERE routine_id = ?`);
      for (const rid of routineIds) delRuns.run(rid);
      this.db.prepare(`DELETE FROM routines WHERE repo_id = ?`).run(repoId);
      this.db.prepare(`DELETE FROM repos WHERE id = ?`).run(repoId);
    })(id);
  }

  // ---- tasks ----
  insertTask(t: TaskState) {
    this.db.prepare(
      `INSERT INTO tasks (id, repo_id, agent, title, prompt, status, interrupted, session_id,
         branch, worktree_path, permission, model, effort, pr_url, pr_urls, pending_input, created_at, updated_at, last_activity_at)
       VALUES (@id, @repo_id, @agent, @title, @prompt, @status, @interrupted, @session_id,
         @branch, @worktree_path, @permission, @model, @effort, @pr_url, @pr_urls, @pending_input, @created_at, @updated_at, @last_activity_at)`,
    ).run(taskToRow(t));
  }
  getTask(id: string): TaskState | undefined {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
    return row && rowToTask(row);
  }
  listTasks(status?: TaskStatus): TaskState[] {
    const rows = status
      ? this.db.prepare(`SELECT * FROM tasks WHERE status = ? ORDER BY created_at`).all(status)
      : this.db.prepare(`SELECT * FROM tasks ORDER BY created_at`).all();
    return (rows as TaskRow[]).map(rowToTask);
  }
  setTaskStatus(id: string, status: TaskStatus, interrupted: boolean, now: number) {
    this.db.prepare(
      `UPDATE tasks SET status = ?, interrupted = ?, updated_at = ? WHERE id = ?`,
    ).run(status, interrupted ? 1 : 0, now, id);
  }
  setTaskSession(id: string, sessionId: string, now: number) {
    this.db.prepare(`UPDATE tasks SET session_id = ?, updated_at = ? WHERE id = ?`).run(sessionId, now, id);
  }
  setTaskSettings(id: string, model: string | undefined, effort: string | undefined, permission: string, now: number) {
    this.db.prepare(
      `UPDATE tasks SET model = ?, effort = ?, permission = ?, updated_at = ? WHERE id = ?`,
    ).run(model ?? null, effort ?? null, permission, now, id);
  }
  setTaskWorktree(id: string, branch: string, worktreePath: string, now: number) {
    this.db.prepare(
      `UPDATE tasks SET branch = ?, worktree_path = ?, updated_at = ? WHERE id = ?`,
    ).run(branch, worktreePath, now, id);
  }
  touchTask(id: string, now: number) {
    this.db.prepare(`UPDATE tasks SET last_activity_at = ? WHERE id = ?`).run(now, id);
  }
  // Persist the task's full PR list (JSON) plus the back-compat first-PR url.
  setTaskPrs(id: string, prs: PrRef[], now: number) {
    this.db.prepare(`UPDATE tasks SET pr_urls = ?, pr_url = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify(prs), prs[0]?.url ?? null, now, id,
    );
  }
  // The pending AskUserQuestion the task is paused on (NULL clears it once answered
  // or the turn settles). Stored as JSON so the inbox can render it across restarts.
  setTaskPendingInput(id: string, pending: QuestionRequest | undefined, now: number) {
    this.db.prepare(`UPDATE tasks SET pending_input = ?, updated_at = ? WHERE id = ?`).run(
      pending ? JSON.stringify(pending) : null, now, id,
    );
  }
  // Reattach high-water-mark: the last stdout line seq durably persisted for the
  // active turn. Reset to 0 when a new turn starts (resume/followup).
  setTaskRawSeq(id: string, seq: number) {
    this.db.prepare(`UPDATE tasks SET last_raw_seq = ? WHERE id = ?`).run(seq, id);
  }
  getTaskRawSeq(id: string): number {
    const row = this.db.prepare(`SELECT last_raw_seq FROM tasks WHERE id = ?`).get(id) as
      | { last_raw_seq: number }
      | undefined;
    return row?.last_raw_seq ?? 0;
  }

  // Tasks that were in flight (running/awaiting/queued) when we last died.
  inFlightTaskIds(): string[] {
    return (
      this.db.prepare(
        `SELECT id FROM tasks WHERE status IN ('running','awaiting_approval','awaiting_input','queued')`,
      ).all() as { id: string }[]
    ).map((r) => r.id);
  }

  // Restart recovery: in-flight turns NOT still alive in the runner daemon are
  // unrecoverable as processes, but the transcript + worktree survive — mark them
  // idle+interrupted so they can be resumed. `keep` is the set of ids reattached
  // to a live daemon turn (left untouched). Returns the reset ids. With the
  // in-process backend `keep` is always empty → every in-flight task resets,
  // exactly the pre-daemon behavior.
  recoverInFlight(now: number, keep?: Set<string>): string[] {
    const ids = this.inFlightTaskIds().filter((id) => !keep?.has(id));
    // Reset to resumable idle; clear any pending question (a reset turn can't be
    // answered — the next follow-up resumes the session fresh).
    const reset = this.db.prepare(`UPDATE tasks SET status='idle', interrupted=1, pending_input=NULL, updated_at=? WHERE id=?`);
    const tx = this.db.transaction((list: string[]) => {
      for (const id of list) reset.run(now, id);
    });
    if (ids.length) tx(ids);
    return ids;
  }

  // ---- events (append-only log; backs SSE replay) ----
  insertEvent(taskId: string, kind: string, payload: unknown, ts: number): { id: number; seq: number } {
    const info = this.insertEventStmt.run(taskId, taskId, kind, JSON.stringify(payload ?? null), ts);
    const id = Number(info.lastInsertRowid);
    const { seq } = this.getSeqStmt.get(id) as { seq: number };
    return { id, seq };
  }

  // Replay for the inbox stream: rows whose global id is past Last-Event-ID.
  eventsAfterGlobal(afterId: number, limit = 5000): EventRow[] {
    const rows = this.db.prepare(
      `SELECT e.id, e.seq, e.task_id, e.kind, e.payload_json, e.ts, t.agent, t.session_id
       FROM events e JOIN tasks t ON t.id = e.task_id
       WHERE e.id > ? ORDER BY e.id LIMIT ?`,
    ).all(afterId, limit) as EventJoinRow[];
    return rows.map(rowToEvent);
  }
  // Replay for a scoped stream: a single task's rows past its Last-Event-ID (seq).
  eventsAfterSeq(taskId: string, afterSeq: number, limit = 5000): EventRow[] {
    const rows = this.db.prepare(
      `SELECT e.id, e.seq, e.task_id, e.kind, e.payload_json, e.ts, t.agent, t.session_id
       FROM events e JOIN tasks t ON t.id = e.task_id
       WHERE e.task_id = ? AND e.seq > ? ORDER BY e.seq LIMIT ?`,
    ).all(taskId, afterSeq, limit) as EventJoinRow[];
    return rows.map(rowToEvent);
  }

  // ---- usage (per-agent aggregate over the result event log) ----
  // Usage is asymmetric and lives inside result events' payload_json (Claude:
  // total_cost_usd/duration_ms; Codex: a usage token object), so we parse + fold
  // in JS rather than via SQL. One result row per completed turn keeps it cheap.
  usageByAgent(): AgentUsage[] {
    const acc = new Map<AgentKind, AgentUsage>();
    const bucket = (agent: AgentKind): AgentUsage => {
      let u = acc.get(agent);
      if (!u) {
        u = {
          agent, taskCount: 0, turnCount: 0, totalCostUsd: 0, durationMs: 0,
          inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
        };
        acc.set(agent, u);
      }
      return u;
    };
    // Tasks ever dispatched per agent (any final status counts as usage).
    for (const r of this.db.prepare(`SELECT agent, COUNT(*) AS n FROM tasks GROUP BY agent`).all() as {
      agent: string;
      n: number;
    }[]) {
      bucket(r.agent as AgentKind).taskCount = r.n;
    }
    // Fold every result payload into its owning agent's running totals.
    const rows = this.db.prepare(
      `SELECT t.agent AS agent, e.payload_json AS payload_json
       FROM events e JOIN tasks t ON t.id = e.task_id
       WHERE e.kind = 'result'`,
    ).all() as { agent: string; payload_json: string }[];
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    for (const row of rows) {
      const u = bucket(row.agent as AgentKind);
      u.turnCount += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.payload_json);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;
      const p = parsed as Record<string, unknown>;
      u.totalCostUsd += num(p.total_cost_usd); // Claude
      u.durationMs += num(p.duration_ms); // Claude
      const usage = p.usage; // Codex
      if (usage && typeof usage === "object") {
        const g = usage as Record<string, unknown>;
        u.inputTokens += num(g.input_tokens);
        u.cachedInputTokens += num(g.cached_input_tokens);
        u.outputTokens += num(g.output_tokens);
        u.reasoningOutputTokens += num(g.reasoning_output_tokens);
      }
    }
    return [...acc.values()].sort((a, b) => a.agent.localeCompare(b.agent));
  }

  // ---- approvals ----
  insertApproval(taskId: string, eventId: number | null, requestJson: string | null, decision: string, decidedAt: number) {
    this.db.prepare(
      `INSERT INTO approvals (task_id, event_id, request_json, decision, decided_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(taskId, eventId, requestJson, decision, decidedAt);
  }

  // ---- web push subscriptions ----
  upsertPushSub(sub: PushSubscriptionJson, now: number) {
    this.db.prepare(
      `INSERT INTO push_subs (endpoint, subscription_json, created_at) VALUES (?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET subscription_json = excluded.subscription_json`,
    ).run(sub.endpoint, JSON.stringify(sub), now);
  }
  deletePushSub(endpoint: string) {
    this.db.prepare(`DELETE FROM push_subs WHERE endpoint = ?`).run(endpoint);
  }
  listPushSubs(): PushSubscriptionJson[] {
    const rows = this.db.prepare(`SELECT subscription_json FROM push_subs`).all() as {
      subscription_json: string;
    }[];
    return rows.map((r) => JSON.parse(r.subscription_json) as PushSubscriptionJson);
  }

  // ---- routines ----
  insertRoutine(r: Routine) {
    this.db.prepare(
      `INSERT INTO routines (id, repo_id, agent, title, prompt, permission, model, effort, preset, schedule,
         enabled, last_run_at, next_run_at, created_at, updated_at)
       VALUES (@id, @repo_id, @agent, @title, @prompt, @permission, @model, @effort, @preset, @schedule,
         @enabled, @last_run_at, @next_run_at, @created_at, @updated_at)`,
    ).run(routineToRow(r));
  }
  updateRoutine(r: Routine) {
    this.db.prepare(
      `UPDATE routines SET repo_id=@repo_id, agent=@agent, title=@title, prompt=@prompt,
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
  // ---- routine run history ----
  insertRoutineRun(run: Omit<RoutineRun, "id">): void {
    this.db.prepare(
      `INSERT INTO routine_runs (routine_id, fired_at, status, task_id, note)
       VALUES (@routine_id, @fired_at, @status, @task_id, @note)`,
    ).run({
      routine_id: run.routineId,
      fired_at: run.firedAt,
      status: run.status,
      task_id: run.taskId ?? null,
      note: run.note ?? null,
    });
  }
  listRoutineRuns(routineId: string, limit = 20): RoutineRun[] {
    return (
      this.db
        .prepare(`SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY fired_at DESC, id DESC LIMIT ?`)
        .all(routineId, limit) as RoutineRunRow[]
    ).map(rowToRoutineRun);
  }

  // ---- WebAuthn credentials / sessions / enroll tokens (auth) ----
  insertCredential(c: StoredCredential) {
    this.db.prepare(
      `INSERT INTO webauthn_credentials (credential_id, public_key, counter, transports, label, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      c.credentialId, c.publicKey, c.counter,
      c.transports ? JSON.stringify(c.transports) : null,
      c.label ?? null, c.createdAt, c.lastUsedAt ?? null,
    );
  }
  getCredential(credentialId: string): StoredCredential | undefined {
    const row = this.db.prepare(`SELECT * FROM webauthn_credentials WHERE credential_id = ?`).get(credentialId) as
      | CredentialRow
      | undefined;
    return row && rowToCredential(row);
  }
  listCredentials(): StoredCredential[] {
    return (this.db.prepare(`SELECT * FROM webauthn_credentials ORDER BY created_at`).all() as CredentialRow[]).map(
      rowToCredential,
    );
  }
  countCredentials(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM webauthn_credentials`).get() as { n: number }).n;
  }
  bumpCredentialCounter(credentialId: string, counter: number, lastUsedAt: number) {
    this.db.prepare(
      `UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE credential_id = ?`,
    ).run(counter, lastUsedAt, credentialId);
  }
  deleteCredential(credentialId: string): boolean {
    return this.db.prepare(`DELETE FROM webauthn_credentials WHERE credential_id = ?`).run(credentialId).changes > 0;
  }

  createSession(token: string, createdAt: number, expiresAt: number, label?: string) {
    this.db.prepare(
      `INSERT INTO auth_sessions (token, created_at, expires_at, label) VALUES (?, ?, ?, ?)`,
    ).run(token, createdAt, expiresAt, label ?? null);
  }
  getSession(token: string): { token: string; createdAt: number; expiresAt: number } | undefined {
    const row = this.db.prepare(`SELECT token, created_at, expires_at FROM auth_sessions WHERE token = ?`).get(token) as
      | { token: string; created_at: number; expires_at: number }
      | undefined;
    return row && { token: row.token, createdAt: row.created_at, expiresAt: row.expires_at };
  }
  refreshSession(token: string, expiresAt: number) {
    this.db.prepare(`UPDATE auth_sessions SET expires_at = ? WHERE token = ?`).run(expiresAt, token);
  }
  deleteSession(token: string) {
    this.db.prepare(`DELETE FROM auth_sessions WHERE token = ?`).run(token);
  }
  pruneExpiredSessions(now: number) {
    this.db.prepare(`DELETE FROM auth_sessions WHERE expires_at <= ?`).run(now);
  }

  createEnrollToken(token: string, expiresAt: number) {
    this.db.prepare(`INSERT INTO enroll_tokens (token, expires_at, used_at) VALUES (?, ?, NULL)`).run(token, expiresAt);
  }
  // Non-consuming validity check (used at register/options; the token is only
  // consumed on a *successful* registration so a cancelled ceremony doesn't burn it).
  isEnrollTokenValid(token: string, now: number): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM enroll_tokens WHERE token = ? AND used_at IS NULL AND expires_at > ?`)
      .get(token, now);
    return !!row;
  }
  // Atomically consume a single-use enroll token: valid only if it exists, is
  // unused, and is not expired. Marks it used and returns whether it was valid.
  consumeEnrollToken(token: string, now: number): boolean {
    return (
      this.db
        .prepare(`UPDATE enroll_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL AND expires_at > ?`)
        .run(now, token, now).changes > 0
    );
  }

  close() {
    this.db.close();
  }
}

export interface StoredCredential {
  credentialId: string;
  publicKey: string; // base64url-encoded COSE public key
  counter: number;
  transports?: string[];
  label?: string | null;
  createdAt: number;
  lastUsedAt?: number | null;
}
type CredentialRow = {
  credential_id: string; public_key: string; counter: number; transports: string | null;
  label: string | null; created_at: number; last_used_at: number | null;
};
function rowToCredential(r: CredentialRow): StoredCredential {
  return {
    credentialId: r.credential_id,
    publicKey: r.public_key,
    counter: r.counter,
    transports: r.transports ? (JSON.parse(r.transports) as string[]) : undefined,
    label: r.label,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  };
}

function rowToRepo(r: RepoRow): Repo {
  return {
    id: r.id,
    name: r.name,
    path: r.path,
    vcs: r.vcs === "none" ? "none" : "git",
    defaultBaseRef: r.default_base_ref,
    createdAt: r.created_at,
  };
}

// The task's PR list: parse the JSON column when present, else synthesize a
// single PrRef from the legacy pr_url column (pre-multi-PR rows). Bad JSON
// falls back to the legacy url so a corrupt cell never throws on load.
function parsePrs(r: TaskRow): PrRef[] | undefined {
  if (r.pr_urls) {
    try {
      const prs = JSON.parse(r.pr_urls) as PrRef[];
      if (Array.isArray(prs) && prs.length) return prs;
    } catch {
      /* fall through to legacy */
    }
  }
  if (r.pr_url) {
    const ref = makePrRef(r.pr_url);
    if (ref) return [ref];
  }
  return undefined;
}

function rowToTask(r: TaskRow): TaskState {
  return {
    taskId: r.id,
    repoId: r.repo_id,
    agent: r.agent as AgentKind,
    title: r.title ?? undefined,
    prompt: r.prompt,
    status: r.status as TaskStatus,
    interrupted: r.interrupted === 1,
    sessionId: r.session_id ?? undefined,
    branch: r.branch ?? undefined,
    worktreePath: r.worktree_path ?? undefined,
    permission: r.permission as Permission,
    model: r.model ?? undefined,
    effort: r.effort ?? undefined,
    prs: parsePrs(r),
    prUrl: r.pr_url ?? undefined,
    pendingInput: r.pending_input ? (JSON.parse(r.pending_input) as QuestionRequest) : undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastActivityAt: r.last_activity_at,
  };
}

function taskToRow(t: TaskState) {
  return {
    id: t.taskId,
    repo_id: t.repoId,
    agent: t.agent,
    title: t.title ?? null,
    prompt: t.prompt,
    status: t.status,
    interrupted: t.interrupted ? 1 : 0,
    session_id: t.sessionId ?? null,
    branch: t.branch ?? null,
    worktree_path: t.worktreePath ?? null,
    permission: t.permission,
    model: t.model ?? null,
    effort: t.effort ?? null,
    pr_url: t.prs?.[0]?.url ?? t.prUrl ?? null,
    pr_urls: t.prs && t.prs.length ? JSON.stringify(t.prs) : null,
    pending_input: t.pendingInput ? JSON.stringify(t.pendingInput) : null,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
    last_activity_at: t.lastActivityAt,
  };
}

function rowToRoutine(r: RoutineRow): Routine {
  return {
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

// Reconstruct a normalized AgentEvent from a stored row. agent + sessionId come
// from the owning task (both are stable per task), payload from payload_json.
function rowToEvent(r: EventJoinRow): EventRow {
  return {
    id: r.id,
    seq: r.seq,
    event: {
      taskId: r.task_id,
      agent: r.agent as AgentKind,
      kind: r.kind as AgentEvent["kind"],
      sessionId: r.session_id ?? undefined,
      payload: JSON.parse(r.payload_json),
      ts: r.ts,
    },
  };
}
