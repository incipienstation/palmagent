import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { Db } from "../../src/composition/database.js";

test("existing databases gain pin metadata without changing tasks, including across restarts", t => {
  const dir = mkdtempSync(join(tmpdir(), "palmagent-pins-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.db");
  const original = new Db(path);
  original.insertRepo({ id: "r", name: "fixture", path: dir, vcs: "none", defaultBaseRef: "", createdAt: 1 });
  original.insertTask({ taskId: "a", repoId: "r", agent: "codex", prompt: "Keep history", status: "idle", permission: "read-only", interrupted: false, createdAt: 1, updatedAt: 2, lastActivityAt: 3 });
  const before = original.getTask("a");
  original.close();
  const legacy = new Database(path);
  legacy.exec("ALTER TABLE tasks DROP COLUMN pinned_at");
  legacy.close();
  const migrated = new Db(path);
  assert.deepEqual(migrated.getTask("a"), before);
  assert.equal(migrated.setTaskPin("a", true, 100), 100);
  migrated.close();
  const reopened = new Db(path);
  try {
    assert.deepEqual(reopened.getTask("a"), { ...before, pinnedAt: 100, updatedAt: 100 });
    reopened.insertTask({ ...before!, taskId: "b" });
    assert.equal(reopened.setTaskPin("b", true, 99), 101, "clock rollback keeps new pins last");
    reopened.setTaskStatus("a", "archived", false, 102);
    assert.equal(reopened.getTask("a")!.pinnedAt, undefined);
    assert.equal(reopened.getTask("a")!.lastActivityAt, 3);
  } finally { reopened.close(); }
});

test("pin order writes roll back the whole move if a row update fails", t => {
  const dir = mkdtempSync(join(tmpdir(), "palmagent-pin-order-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Db(join(dir, "state.db"));
  t.after(() => db.close());
  db.insertRepo({ id: "r", name: "fixture", path: dir, vcs: "none", defaultBaseRef: "", createdAt: 1 });
  for (const [index, taskId] of ["a", "b", "c"].entries()) db.insertTask({ taskId, repoId: "r", pinnedAt: index + 10, agent: "codex", prompt: "Keep history", status: "idle", permission: "read-only", interrupted: false, createdAt: 1, updatedAt: 2, lastActivityAt: 3 });
  const before = db.listTasks();
  const connection = new Database(db.path);
  connection.exec("CREATE TRIGGER reject_pin_update BEFORE UPDATE OF pinned_at ON tasks WHEN NEW.id = 'b' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  connection.close();
  assert.throws(() => db.setTaskPinOrder([{ taskId: "c", pinnedAt: 10 }, { taskId: "a", pinnedAt: 11 }, { taskId: "b", pinnedAt: 12 }], 100), /fixture failure/);
  assert.deepEqual(db.listTasks(), before);
});
