import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repo, TaskState } from "@palmagent/shared";
import { openDatabase } from "../../src/platform/sqlite/connection.js";
import { SqliteSpaces } from "../../src/modules/spaces/adapters/outbound/sqlite-spaces.js";
import { SqliteTasks } from "../../src/modules/tasks/adapters/outbound/sqlite-tasks.js";
import { SqliteAuth } from "../../src/modules/auth/adapters/outbound/sqlite-auth.js";
import { SqliteRoutines } from "../../src/modules/routines/adapters/outbound/sqlite-routines.js";

const repo: Repo = { id: "space", name: "Fixture", path: "/fixture", vcs: "none", defaultBaseRef: "", createdAt: 1 };
const task: TaskState = { taskId: "task", repoId: repo.id, agent: "codex", prompt: "Fixture", status: "idle", interrupted: false, permission: "default", createdAt: 1, updatedAt: 1, lastActivityAt: 1 };

test("feature repositories share rollback, event ordering and Space cascade semantics", t => {
  const directory = mkdtempSync(join(tmpdir(), "palmagent-repositories-"));
  const connection = openDatabase(join(directory, "state.sqlite"));
  t.after(() => { connection.close(); rmSync(directory, { recursive: true, force: true }); });
  const spaces = new SqliteSpaces(connection), tasks = new SqliteTasks(connection), auth = new SqliteAuth(connection), routines = new SqliteRoutines(connection);
  assert.throws(() => tasks.transaction(() => {
    spaces.insertRepo(repo); tasks.insertTask(task); auth.createSession("session", 1, 2);
    tasks.insertEvent(task.taskId, "system", { text: "rolled back" }, 1);
    throw new Error("abort all features");
  }), /abort all features/);
  assert.equal(spaces.getRepo(repo.id), undefined);
  assert.equal(tasks.getTask(task.taskId), undefined);
  assert.equal(auth.getSession("session"), undefined);
  assert.equal(tasks.eventCursor(), 0);
  tasks.transaction(() => { spaces.insertRepo(repo); tasks.insertTask(task); });
  const first = tasks.insertEvent(task.taskId, "system", { text: "first" }, 1);
  assert.throws(() => tasks.transaction(() => { tasks.insertEvent(task.taskId, "system", { text: "abort" }, 2); throw new Error("abort"); }));
  const second = tasks.insertEvent(task.taskId, "system", { text: "second" }, 3);
  assert.deepEqual([first.seq, second.seq], [1, 2]);
  tasks.insertApproval(task.taskId, first.id, null, "allow", 3);
  routines.insertRoutine({ id: "routine", repoId: repo.id, agent: "codex", kind: "agent", prompt: "Fixture", permission: "default", preset: "manual", schedule: "", enabled: false, createdAt: 1, updatedAt: 1 });
  spaces.deleteRepo(repo.id);
  assert.deepEqual(tasks.listTasks(), []);
  assert.deepEqual(routines.listRoutines(), []);
  assert.equal(tasks.eventCursor(), 0);
  assert.equal((connection.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }).n, 0);
});
