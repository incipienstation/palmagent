import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { deferActivityEventDetails, type AgentEvent, type TaskState } from "@palmagent/shared";
import { openDatabase } from "../../src/platform/sqlite/connection.js";
import { SqliteSpaces } from "../../src/modules/spaces/adapters/outbound/sqlite-spaces.js";
import { SqliteTasks } from "../../src/modules/tasks/adapters/outbound/sqlite-tasks.js";

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "palmagent-read-projections-"));
  const path = join(directory, "state.sqlite");
  const connection = openDatabase(path);
  const spaces = new SqliteSpaces(connection), tasks = new SqliteTasks(connection);
  spaces.insertRepo({ id: "space", name: "Fixture", path: directory, vcs: "none", defaultBaseRef: "", createdAt: 1 });
  const task: TaskState = { taskId: "task", repoId: "space", agent: "codex", prompt: "Fixture", status: "idle", interrupted: false,
    permission: "default", createdAt: 1, updatedAt: 1, lastActivityAt: 1 };
  tasks.insertTask(task);
  t.after(() => { connection.close(); rmSync(directory, { recursive: true, force: true }); });
  return { connection, spaces, tasks, task, path };
}

test("compact history and catch-up parse persisted summaries while full reads preserve payloads", t => {
  const f = fixture(t);
  const payloads = [
    { id: "call", name: "Read", input: { path: "fixture.txt" }, is_error: false, exit_code: 0 },
    { tool_use_id: "call", output: "tool-body-marker" + "x".repeat(65536), is_error: true, status: null },
    // Even unusual historical field types preserve the shared projection's semantics.
    { id: { nested: true }, status: ["done", false], exit_code: null, output: "tool-body-marker" },
    null, ["tool-body-marker"], "tool-body-marker",
  ];
  const events = payloads.map((payload, i) => ({ taskId: "task", agent: "codex", kind: i === 0 ? "tool_call" : "tool_result", payload, ts: i } as AgentEvent));
  f.tasks.appendAgentEvents("task", events);
  const parse = JSON.parse;
  let detailParses = 0;
  t.mock.method(JSON, "parse", (value: string) => {
    if (value.includes("tool-body-marker")) detailParses++;
    return parse(value);
  });
  const compact = f.tasks.latestHistoryPage("task", false);
  assert.equal(compact.before, null);
  assert.deepEqual(compact.events.map(row => row.event.payload), events.map(event => deferActivityEventDetails(event).event.payload));
  assert.ok(compact.events.every(row => row.detailsDeferred));
  const changes = f.tasks.historyChanges("task", 0, compact.cursor, false);
  assert.deepEqual(changes.events, compact.events);
  assert.equal(detailParses, 0, "summary reads must not parse full tool output");
  assert.deepEqual(f.tasks.latestHistoryPage("task").events.map(row => row.event.payload), payloads);
  assert.deepEqual(f.tasks.activityDetails("task", 1, compact.cursor).events.map(row => row.event.payload), payloads);
  assert.ok(detailParses > 0);
});

test("existing history backfills transactionally and projections follow imports, updates and deletion", t => {
  const f = fixture(t);
  f.connection.exec("DROP TRIGGER event_compact_insert; DROP TRIGGER event_compact_update; DROP TABLE event_compact_payloads");
  const first = f.tasks.insertEvent("task", "tool_call", { id: "legacy", name: "Read", input: "old detail" }, 1);
  const exec = f.connection.exec.bind(f.connection);
  const interrupted = t.mock.method(f.connection, "exec", (sql: string) => {
    const result = exec(sql);
    if (sql.startsWith("INSERT INTO event_compact_payloads")) throw new Error("interrupted backfill");
    return result;
  });
  assert.throws(() => new SqliteTasks(f.connection), /interrupted backfill/);
  assert.equal(f.connection.prepare("SELECT 1 FROM sqlite_master WHERE name = 'event_compact_payloads'").get(), undefined);
  assert.equal(f.tasks.eventCursor("task"), first.seq);
  interrupted.mock.restore();
  const tasks = new SqliteTasks(f.connection);
  assert.deepEqual(tasks.latestHistoryPage("task", false).events[0].event.payload, { id: "legacy", name: "Read" });
  assert.equal(tasks.eventCursor("task"), first.seq);
  tasks.importSessionEvents(f.task, [{ taskId: "task", agent: "codex", kind: "tool_result", payload: { tool_use_id: "legacy", output: "imported detail" }, ts: 2 }]);
  assert.deepEqual(tasks.latestHistoryPage("task", false).events[1].event.payload, { tool_use_id: "legacy" });
  const update = f.connection.prepare("UPDATE events SET kind = ?, payload_json = ? WHERE id = ?");
  update.run("tool_result", JSON.stringify({ tool_use_id: "changed", output: "new detail", is_error: false }), first.id);
  assert.deepEqual(tasks.latestHistoryPage("task", false).events[0].event.payload, { tool_use_id: "changed", is_error: false });
  assert.throws(() => tasks.transaction(() => {
    update.run("assistant_text", JSON.stringify({ text: "rolled back" }), first.id);
    tasks.insertEvent("task", "tool_result", { output: "rolled back" }, 3);
    throw new Error("rollback");
  }), /rollback/);
  assert.equal(tasks.eventCursor("task"), 2);
  assert.equal(tasks.latestHistoryPage("task", false).events[0].detailsDeferred, true);
  update.run("assistant_text", JSON.stringify({ text: "converted" }), first.id);
  assert.deepEqual(tasks.latestHistoryPage("task", false).events[0].event.payload, { text: "converted" });
  assert.equal(tasks.latestHistoryPage("task", false).events[0].detailsDeferred, false);
  // A fresh repository instance reuses the durable projection.
  f.connection.exec("CREATE TRIGGER no_second_compact_backfill BEFORE INSERT ON event_compact_payloads BEGIN SELECT RAISE(ABORT, 'already projected'); END");
  assert.deepEqual(new SqliteTasks(f.connection).latestHistoryPage("task", false), tasks.latestHistoryPage("task", false));
  f.spaces.deleteRepo("space");
  assert.equal((f.connection.prepare("SELECT COUNT(*) AS n FROM event_compact_payloads").get() as { n: number }).n, 0);
});

test("Usage caches unchanged totals and invalidates across imports and other SQLite connections", t => {
  const f = fixture(t);
  const payload = (tokens: number) => ({ result: "usage-body-marker", usage: { input_tokens: tokens } });
  const first = f.tasks.insertEvent("task", "result", payload(1), 1);
  const parse = JSON.parse;
  let resultParses = 0;
  t.mock.method(JSON, "parse", (value: string) => {
    if (value.includes("usage-body-marker")) resultParses++;
    return parse(value);
  });
  const initial = f.tasks.usageByAgent();
  assert.equal(initial[0].inputTokens, 1);
  assert.equal(resultParses, 1);
  initial[0].inputTokens = 999;
  initial[0].reported!.length = 0;
  assert.equal(f.tasks.usageByAgent()[0].inputTokens, 1);
  assert.deepEqual(f.tasks.usageByAgent()[0].reported, ["inputTokens"]);
  f.tasks.insertEvent("task", "assistant_text", { text: "unrelated live output" }, 2);
  f.tasks.setTaskTitle("task", "Renamed", 2);
  f.tasks.usageByAgent();
  assert.equal(resultParses, 1, "unrelated output and metadata retain the cached totals");
  f.tasks.importSessionEvents(f.task, [{ taskId: "task", agent: "codex", kind: "result", payload: payload(2), ts: 3 }]);
  assert.equal(f.tasks.usageByAgent()[0].inputTokens, 3);

  const writer = new Database(f.path);
  try {
    writer.prepare("UPDATE events SET payload_json = ? WHERE id = ?").run(JSON.stringify(payload(10)), first.id);
    assert.equal(f.tasks.usageByAgent()[0].inputTokens, 12);
    writer.prepare("DELETE FROM events WHERE id = ?").run(first.id);
    assert.equal(f.tasks.usageByAgent()[0].inputTokens, 2);
    writer.prepare("UPDATE tasks SET agent = 'claude' WHERE id = 'task'").run();
    assert.equal(f.tasks.usageByAgent()[0].agent, "claude");
  } finally { writer.close(); }
  f.tasks.insertTask({ ...f.task, taskId: "second", agent: "claude" });
  assert.equal(f.tasks.usageByAgent()[0].taskCount, 2);
  f.spaces.deleteRepo("space");
  assert.deepEqual(f.tasks.usageByAgent(), []);
});

test("Usage observed inside a rolled-back transaction cannot poison a later reused revision", t => {
  const f = fixture(t);
  const add = (input_tokens: number) => f.tasks.insertEvent("task", "result", { usage: { input_tokens } }, 1);
  add(1);
  assert.equal(f.tasks.usageByAgent()[0].inputTokens, 1);
  assert.throws(() => f.tasks.transaction(() => {
    add(100);
    assert.equal(f.tasks.usageByAgent()[0].inputTokens, 101);
    throw new Error("rollback");
  }), /rollback/);
  add(2);
  assert.equal(f.tasks.usageByAgent()[0].inputTokens, 3);
  const reopened = openDatabase(f.path);
  try { assert.equal(new SqliteTasks(reopened).usageByAgent()[0].inputTokens, 3); }
  finally { reopened.close(); }
});
