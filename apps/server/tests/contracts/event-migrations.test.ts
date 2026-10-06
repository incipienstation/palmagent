import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Db } from "../../src/composition/database.js";
import { migrateEventData } from "../../src/platform/sqlite/event-migrations.js";

const message = "Codex exited before a terminal turn result.";
test("opening an old database backfills event codes once without changing history identity", t => {
  const directory = mkdtempSync(join(tmpdir(), "palmagent-event-migration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "state.db");
  const original = new Db(path);
  original.insertRepo({ id: "r", name: "fixture", path: directory, vcs: "none", defaultBaseRef: "", createdAt: 1 });
  for (const agent of ["codex", "claude"] as const) original.insertTask({ taskId: agent, repoId: "r", agent,
    prompt: "fixture", status: "idle", interrupted: false, permission: "readonly", createdAt: 1, updatedAt: 2, lastActivityAt: 3 });
  original.insertEvent("codex", "error", { message, extra: { keep: true } }, 10);
  original.insertEvent("codex", "error", { message, code: "another_reason" }, 11);
  original.insertEvent("codex", "error", { message, code: null }, 12);
  original.insertEvent("codex", "status", { message }, 13);
  original.insertEvent("codex", "error", { message: "Other failure" }, 14);
  original.insertEvent("claude", "error", { message }, 15);
  const task = original.getTask("codex");
  original.close();
  const legacy = new Database(path);
  legacy.exec("DROP TABLE data_migrations");
  const before = legacy.prepare("SELECT * FROM events ORDER BY id").all() as Record<string, unknown>[];
  legacy.close();
  const migrated = new Db(path);
  assert.deepEqual(migrated.getTask("codex"), task);
  migrated.close();
  const read = new Database(path);
  const after = read.prepare("SELECT * FROM events ORDER BY id").all() as Record<string, unknown>[];
  assert.deepEqual(after[0], { ...before[0], payload_json: JSON.stringify({ message, extra: { keep: true }, code: "turn_result_missing" }) });
  assert.deepEqual(after.slice(1), before.slice(1));
  assert.equal((read.prepare("SELECT count(*) AS n FROM data_migrations").get() as { n: number }).n, 1);
  read.exec("CREATE TRIGGER no_second_backfill BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'already migrated'); END");
  read.close();
  new Db(path).close();
});

test("event backfill ignores malformed payloads and rolls back atomically on failure", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE tasks (id TEXT, agent TEXT); INSERT INTO tasks VALUES ('t','codex'); CREATE TABLE events (task_id TEXT, kind TEXT, payload_json TEXT)");
    const insert = db.prepare("INSERT INTO events VALUES ('t', 'error', ?)");
    for (const payload of ["broken", "null", "[]", "42", JSON.stringify({ message })]) insert.run(payload);
    db.exec("CREATE TRIGGER fail_backfill BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    assert.throws(() => migrateEventData(db), /fixture failure/);
    assert.equal((db.prepare("SELECT count(*) AS n FROM data_migrations").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT payload_json FROM events WHERE rowid=5").get() as { payload_json: string }).payload_json, JSON.stringify({ message }));
    db.exec("DROP TRIGGER fail_backfill");
    migrateEventData(db);
    const rows = db.prepare("SELECT payload_json FROM events ORDER BY rowid").all() as { payload_json: string }[];
    assert.deepEqual(rows.slice(0,4).map(row => row.payload_json), ["broken", "null", "[]", "42"]);
    assert.equal(JSON.parse(rows[4].payload_json).code, "turn_result_missing");
  } finally { db.close(); }
});
