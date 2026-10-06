import type Database from "better-sqlite3";
export function migrateSchema(db: Database.Database) {
    db.exec(`
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
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        media_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        digest TEXT NOT NULL,
        UNIQUE(task_id, digest)
      );
      CREATE TABLE IF NOT EXISTS task_message_state (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        state TEXT NOT NULL
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
    // Additive migrations preserve existing native sessions and task events.
    const taskCols = (db.pragma("table_info(tasks)") as { name: string }[]).map((c) => c.name);
    if (!taskCols.includes("pinned_at")) db.exec("ALTER TABLE tasks ADD COLUMN pinned_at INTEGER");
    if (!taskCols.includes("skills_json")) db.exec("ALTER TABLE tasks ADD COLUMN skills_json TEXT");
    if (!taskCols.includes("session_control")) db.exec("ALTER TABLE tasks ADD COLUMN session_control TEXT");
    if (!taskCols.includes("pr_url")) {
      db.exec(`ALTER TABLE tasks ADD COLUMN pr_url TEXT`);
    }
    // Additive migration for the per-dispatch reasoning-effort selector.
    if (!taskCols.includes("effort")) {
      db.exec(`ALTER TABLE tasks ADD COLUMN effort TEXT`);
    }
    // Additive migration for the runner-daemon reattach high-water-mark: the
    // last stdout line seq durably persisted for the active turn.
    if (!taskCols.includes("last_raw_seq")) {
      db.exec(`ALTER TABLE tasks ADD COLUMN last_raw_seq INTEGER NOT NULL DEFAULT 0`);
    }
    // Additive migration for AskUserQuestion: the unanswered question (JSON) the
    // task is paused on while awaiting_input. NULL when there's nothing pending.
    if (!taskCols.includes("pending_input")) {
      db.exec(`ALTER TABLE tasks ADD COLUMN pending_input TEXT`);
    }
    // Additive migration for provider permission prompts: the unanswered
    // request is durable so the UI and daemon reattach can agree on what is
    // being approved.
    if (!taskCols.includes("pending_approval")) {
      db.exec(`ALTER TABLE tasks ADD COLUMN pending_approval TEXT`);
    }
    // Additive migration for multiple PRs per task: the full PrRef[] (JSON). The
    // legacy single pr_url column stays (kept = prs[0].url); pre-existing rows
    // synthesize their prs from it in rowToTask until the next PR event rewrites it.
    if (!taskCols.includes("pr_urls")) {
      db.exec(`ALTER TABLE tasks ADD COLUMN pr_urls TEXT`);
    }
    const attachmentCols = (db.pragma("table_info(attachments)") as { name: string }[]).map(c => c.name);
    for (const column of ["unused_since", "expired_at"]) {
      if (!attachmentCols.includes(column)) db.exec(`ALTER TABLE attachments ADD COLUMN ${column} INTEGER`);
    }
    const routineRunCols = (db.pragma("table_info(routine_runs)") as { name: string }[]).map(c => c.name);
    if (!routineRunCols.includes("result_json")) db.exec("ALTER TABLE routine_runs ADD COLUMN result_json TEXT");
    const routineCols = (db.pragma("table_info(routines)") as { name: string }[]).map((c) => c.name);
    if (!routineCols.includes("kind")) db.exec("ALTER TABLE routines ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent'");
    if (!routineCols.includes("script_json")) db.exec("ALTER TABLE routines ADD COLUMN script_json TEXT");
    if (!routineCols.includes("effort")) {
      db.exec(`ALTER TABLE routines ADD COLUMN effort TEXT`);
    }
    // Additive migration for friendly schedule presets (every pre-existing row is
    // a raw-cron routine, i.e. "custom").
    if (!routineCols.includes("preset")) {
      db.exec(`ALTER TABLE routines ADD COLUMN preset TEXT NOT NULL DEFAULT 'custom'`);
    }
    // Additive migration for plain-folder repos (every pre-existing row is git).
    const repoCols = (db.pragma("table_info(repos)") as { name: string }[]).map((c) => c.name);
    if (!repoCols.includes("vcs")) {
      db.exec(`ALTER TABLE repos ADD COLUMN vcs TEXT NOT NULL DEFAULT 'git'`);
    }
  }
