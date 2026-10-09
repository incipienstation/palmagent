import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { contextRemaining, type AgentEvent, type TaskState } from "@palmagent/shared";
import { Db } from "../../src/composition/database.js";

function setup(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "palmagent-context-"));
  const path = join(dir, "state.db");
  let db = new Db(path);
  db.insertRepo({ id: "repo", name: "Fixture", path: dir, vcs: "none", defaultBaseRef: "", createdAt: 1 });
  const task: TaskState = { taskId: "task", repoId: "repo", agent: "codex", prompt: "Fixture", status: "idle", interrupted: false,
    sessionId: "session", permission: "read-only", createdAt: 1, updatedAt: 1, lastActivityAt: 1 };
  db.insertTask(task);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { task, path, get db() { return db; }, reopen() { db.close(); db = new Db(path); } };
}
const status = (payload: unknown, ts = 10): AgentEvent => ({ taskId: "task", agent: "codex", sessionId: "session", kind: "status", payload, ts });
const usage = (used: unknown, window: unknown = 200000, ts = 10) => status({ subtype: "usage", usage: {
  last: { totalTokens: used, cachedInputTokens: 80000 }, total: { totalTokens: 9999999 }, modelContextWindow: window,
} }, ts);

test("context uses the latest call, survives restart and does not depend on the history page", t => {
  const f = setup(t);
  f.db.appendAgentEvents("task", [usage(84000)], 1);
  assert.deepEqual(f.db.getTask("task")?.contextUsage, { usedTokens: 84000, windowTokens: 200000, updatedAt: 10 });
  assert.ok(Math.abs(contextRemaining(f.db.getTask("task")?.contextUsage)! - 58) < 0.001);
  f.db.appendAgentEvents("task", Array.from({ length: 600 }, () => status({ subtype: "other" })), 2);
  f.reopen();
  assert.equal(f.db.listTasks()[0].contextUsage?.usedTokens, 84000);
  f.db.appendAgentEvents("task", [usage(120000, 200000, 20)], 3);
  assert.equal(contextRemaining(f.db.getTask("task")?.contextUsage), 40);
  assert.equal(f.db.getTaskRawSeq("task"), 3);
});

test("compaction retains the last reading as stale until a new provider reading arrives", t => {
  const f = setup(t);
  f.db.appendAgentEvents("task", [usage(180000), status({ subtype: "compaction_requested" })]);
  assert.equal(f.db.getTask("task")?.contextUsage?.usedTokens, 180000);
  assert.equal(contextRemaining(f.db.getTask("task")?.contextUsage), null);
  f.reopen();
  assert.equal(f.db.getTask("task")?.contextUsage?.stale, true);
  f.db.appendAgentEvents("task", [status({ subtype: "context_compaction_started" }), usage(20000), status({ subtype: "context_compacted" })]);
  assert.equal(contextRemaining(f.db.getTask("task")?.contextUsage), 90);
  f.db.setTaskSession("task", "other-session", 100);
  assert.equal(f.db.getTask("task")?.contextUsage, undefined);
});

test("missing capacity, invalid readings and overflow never fabricate a percentage", t => {
  const f = setup(t);
  assert.equal(contextRemaining(undefined), null);
  f.db.appendAgentEvents("task", [usage(100, null)]);
  assert.equal(f.db.getTask("task")?.contextUsage?.usedTokens, 100);
  assert.equal(contextRemaining(f.db.getTask("task")?.contextUsage), null);
  for (const value of [-1, "100", NaN, Infinity]) {
    f.db.appendAgentEvents("task", [usage(value)]);
    assert.equal(contextRemaining(f.db.getTask("task")?.contextUsage), null);
  }
  f.db.appendAgentEvents("task", [usage(300000)]);
  assert.equal(contextRemaining(f.db.getTask("task")?.contextUsage), 0);
  f.db.appendAgentEvents("task", [usage(0)]);
  assert.equal(contextRemaining(f.db.getTask("task")?.contextUsage), 100);
});

test("legacy usage events backfill once and transaction rollback preserves event/projection consistency", t => {
  const f = setup(t);
  f.db.insertEvent("task", "status", usage(84000).payload, 10);
  const raw = new Database(f.path); raw.exec("DROP TABLE task_context_usage"); raw.close();
  f.reopen();
  assert.equal(f.db.getTask("task")?.contextUsage?.usedTokens, 84000);
  const cursor = f.db.eventCursor("task");
  assert.throws(() => f.db.transaction(() => {
    f.db.appendAgentEvents("task", [usage(100)]);
    throw new Error("rollback");
  }), /rollback/);
  assert.equal(f.db.eventCursor("task"), cursor);
  assert.equal(f.db.getTask("task")?.contextUsage?.usedTokens, 84000);
});

test("imported local context is projected atomically with the native transcript cursor", t => {
  const f = setup(t);
  const task = { ...f.task, sessionControl: { owner: "returning" as const, home: "/tmp/provider", transcript: "/tmp/session.jsonl", cursor: 123, prefixHash: "fixture" } };
  f.db.importSessionEvents(task, [usage(50000)]);
  f.reopen();
  assert.equal(f.db.getTask("task")?.contextUsage?.usedTokens, 50000);
  assert.equal(f.db.getTask("task")?.sessionControl?.cursor, 123);
});


test("a model change invalidates the old capacity until the provider reports its effective window", t => {
  const f = setup(t);
  f.db.appendAgentEvents("task", [usage(84000)]);
  f.db.setTaskSettings("task", "other-model", undefined, "read-only", 20);
  assert.equal(contextRemaining(f.db.getTask("task")?.contextUsage), null);
  f.db.appendAgentEvents("task", [usage(84000, 400000, 30)]);
  assert.equal(contextRemaining(f.db.getTask("task")?.contextUsage), 79);
  f.db.setTaskSettings("task", "other-model", "high", "read-only", 40);
  assert.equal(contextRemaining(f.db.getTask("task")?.contextUsage), 79);
});
