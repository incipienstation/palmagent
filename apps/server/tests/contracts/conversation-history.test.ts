import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CONVERSATION_PAGE_BYTES, CONVERSATION_PAGE_ITEMS, appendHistoryEvent, presentTranscript,
  type AgentEvent, type ConversationItem, type LogItem, type TaskState } from "@palmagent/shared";
import { openDatabase } from "../../src/platform/sqlite/connection.js";
import { SqliteSpaces } from "../../src/modules/spaces/adapters/outbound/sqlite-spaces.js";
import { SqliteTasks } from "../../src/modules/tasks/adapters/outbound/sqlite-tasks.js";

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "palmagent-conversation-pages-")), path = join(directory, "state.sqlite");
  const connection = openDatabase(path), spaces = new SqliteSpaces(connection), tasks = new SqliteTasks(connection);
  spaces.insertRepo({ id: "space", name: "Fixture", path: directory, vcs: "none", defaultBaseRef: "", createdAt: 1 });
  const task: TaskState = { taskId: "task", repoId: "space", agent: "codex", prompt: "Fixture", status: "idle", interrupted: false,
    permission: "default", createdAt: 1, updatedAt: 1, lastActivityAt: 1 };
  tasks.insertTask(task);
  t.after(() => { connection.close(); rmSync(directory, { recursive: true, force: true }); });
  const add = (events: AgentEvent[]) => tasks.appendAgentEvents("task", events);
  return { connection, tasks, task, path, add };
}
const event = (kind: AgentEvent["kind"], payload: unknown): AgentEvent => ({ taskId: "task", agent: "codex", kind, payload, ts: 1 } as AgentEvent);
const message = (text: string, id = text) => event("assistant_text", { text, messageId: id, phase: "final" });
const user = (text: string) => event("status", { subtype: "followup", text });
const bounded = (value: unknown) => assert.ok(Buffer.byteLength(JSON.stringify(value)) <= CONVERSATION_PAGE_BYTES);

test("first and preceding pages read display records without replaying completed events", t => {
  const f = fixture(t);
  f.add(Array.from({ length: 120 }, (_, i) => [user(`Question ${i}`), ...Array.from({ length: 100 }, () => message("answer ", `answer-${i}`))]).flat());
  let before: number | undefined;
  const keys: number[] = [];
  const prepare = f.connection.prepare.bind(f.connection);
  t.mock.method(f.connection, "prepare", (sql: string) => {
    assert.ok(!sql.includes("FROM events"), "indexed page reads must not replay raw history");
    return prepare(sql);
  });
  do {
    const page = f.tasks.conversationPage("task", before);
    bounded(page);
    assert.equal(page.cursor, 12120);
    assert.equal(page.events.length, 0);
    assert.ok(page.transcript!.length <= CONVERSATION_PAGE_ITEMS);
    keys.unshift(...page.transcript!.map(row => row.key));
    for (const row of page.transcript!) if (row.type === "message" && row.item.kind === "assistant_text") assert.equal(row.item.text, "answer ".repeat(100));
    before = page.before ?? undefined;
  } while (before !== undefined);
  assert.equal(keys.length, 240);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(keys, [...keys].sort((a, b) => a - b));
});

test("a large Activity is one summary with exact counts and separately paged details", t => {
  const f = fixture(t);
  f.add([user("Inspect files"), ...Array.from({ length: 400 }, (_, i) => [
    event("tool_call", { id: `tool-${i}`, name: "Read", input: { path: "fixture.txt" } }),
    event("tool_result", { tool_use_id: `tool-${i}`, output: `Result ${i}: ${"x".repeat(2000)}`, is_error: i === 2 }),
  ]).flat(), message("Finished")]);
  const page = f.tasks.conversationPage("task");
  bounded(page);
  assert.equal(page.transcript!.length, 3);
  const activity = page.transcript!.find(row => row.type === "activity")!;
  assert.equal(activity.type, "activity");
  if (activity.type !== "activity") return;
  assert.equal(activity.summary!.label, "Activity · 400 tools · 1 failed");
  assert.deepEqual(activity.items, []);
  assert.ok(!JSON.stringify(page).includes("Result 399"));
  let after: number | undefined;
  const details: ConversationItem[] = [];
  do {
    const result = f.tasks.conversationDetails("task", activity.key, after);
    bounded(result);
    details.push(...result.items);
    after = result.nextAfter ?? undefined;
  } while (after !== undefined);
  assert.equal(details.length, 800);
  assert.equal(new Set(details.map(row => row.key)).size, 800);
  assert.ok(JSON.stringify(details).includes("Result 399"));
});

test("byte limits defer oversized Unicode messages and tool details without truncation", t => {
  const f = fixture(t), text = "Long message 😀 한글\n".repeat(20000);
  f.add([user("Read"), event("tool_call", { id: "read", name: "Read" }), event("tool_result", { tool_use_id: "read", output: text }), message(text)]);
  const page = f.tasks.conversationPage("task");
  bounded(page);
  const reply = page.transcript!.at(-1)!;
  assert.ok(reply.content);
  const load = (row: ConversationItem) => {
    let offset = 0, body = "";
    do {
      const chunk = f.tasks.conversationContent("task", row.content!.key, row.content!.version, offset, row.content!.member);
      bounded(chunk);
      body += chunk.chunk;
      if (chunk.nextOffset === null) break;
      assert.ok(chunk.nextOffset > offset);
      offset = chunk.nextOffset;
    } while (true);
    return JSON.parse(body);
  };
  assert.equal(load(reply).item.text, text);
  const activity = page.transcript!.find(row => row.type === "activity")!;
  const details = f.tasks.conversationDetails("task", activity.key);
  bounded(details);
  const tool = details.items.find(row => row.content)!;
  assert.equal(load(tool).item.event.payload.output, text);
  assert.throws(() => f.tasks.conversationContent("other-task", reply.key, reply.content!.version, 0), /no longer available/);
  f.add([message("changed", text)]);
  // A growing message cannot be concatenated from different revisions.
  f.add([message("append", text)]);
  assert.throws(() => f.tasks.conversationContent("task", reply.key, reply.content!.version, 0), /changed/);
});

test("late phase classification patches and tombstones page through a shared revision", t => {
  const f = fixture(t);
  const initial = Array.from({ length: 45 }, (_, i) => [
    event("tool_call", { id: `tool-${i}`, name: "Read" }), event("assistant_text", { text: `Progress ${i}`, messageId: `m-${i}` }),
  ]).flat();
  f.add(initial);
  const before = f.tasks.eventCursor("task");
  const markers = Array.from({ length: 45 }, (_, i) => event("status", { subtype: "assistant_message", messageId: `m-${i}`, phase: "progress" }));
  f.add(markers);
  let after = before, afterKey: number | undefined;
  const keys: number[] = [];
  let removed = 0, pages = 0;
  do {
    const result = f.tasks.conversationChanges("task", after, undefined, afterKey);
    bounded(result); pages++;
    for (const patch of result.transcript!) { keys.push(patch.key); removed += Number(!patch.item); }
    if (result.nextAfter === null) break;
    after = result.nextAfter; afterKey = result.nextKey;
  } while (true);
  assert.ok(pages > 1);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(removed >= 45);
  const current = f.tasks.conversationPage("task");
  assert.equal(current.transcript!.length, 1);
  assert.equal(current.transcript![0].type, "activity");
});

test("the projection preserves transcript semantics, recovery, imports and transactional rollback", t => {
  const f = fixture(t);
  const events = [user("First"), event("status", { subtype: "turn_started" }), event("tool_call", { id: "one", name: "Read" }),
    message("partial", "first"), event("error", { message: "Failure" }), event("result", { subtype: "error_during_execution" }),
    user("Next"), event("tool_call", { id: "two", name: "Read" }), message("Done"), event("result", { result: "Done" })];
  f.add(events);
  const log: LogItem[] = [];
  events.forEach((e, i) => appendHistoryEvent(log, e, i + 1));
  const expected = presentTranscript(log, "compact", true);
  const actual = f.tasks.conversationPage("task").transcript!;
  assert.deepEqual(actual.map(row => [row.key, row.type]), expected.map(row => [row.key, row.type]));
  assert.deepEqual(actual.filter(row => row.type === "failure").map(row => row.previous), expected.filter(row => row.type === "failure").map(row => row.previous));
  const snapshot = f.tasks.conversationPage("task");
  assert.throws(() => f.tasks.transaction(() => { f.add([user("Rolled back")]); throw new Error("rollback"); }), /rollback/);
  assert.deepEqual(f.tasks.conversationPage("task"), snapshot);
  f.tasks.importSessionEvents(f.task, [user("Imported")]);
  assert.ok(JSON.stringify(f.tasks.conversationPage("task")).includes("Imported"));
  assert.deepEqual(new SqliteTasks(f.connection).conversationPage("task"), f.tasks.conversationPage("task"));
  const writer = new Database(f.path);
  writer.prepare("UPDATE events SET payload_json = ? WHERE task_id = ? AND seq = 1").run(JSON.stringify({ subtype: "followup", text: "Corrected" }), "task");
  writer.close();
  assert.ok(JSON.stringify(f.tasks.conversationPage("task")).includes("Corrected"));
});

test("existing events backfill atomically once and survive an interrupted upgrade", t => {
  const f = fixture(t);
  f.add([user("Existing request"), message("Existing response")]);
  const expected = f.tasks.conversationPage("task");
  f.connection.exec(`DROP TRIGGER conversation_insert; DROP TRIGGER conversation_update; DROP TRIGGER conversation_delete;
    DROP TABLE conversation_rows; DROP TABLE conversation_state; DROP TABLE conversation_dirty;`);
  const exec = f.connection.exec.bind(f.connection);
  const interrupted = t.mock.method(f.connection, "exec", (sql: string) => {
    const result = exec(sql);
    if (sql.startsWith("INSERT INTO conversation_dirty SELECT")) throw new Error("interrupted upgrade");
    return result;
  });
  assert.throws(() => new SqliteTasks(f.connection), /interrupted upgrade/);
  assert.equal(f.connection.prepare("SELECT 1 FROM sqlite_master WHERE name = 'conversation_rows'").get(), undefined);
  assert.equal(f.tasks.eventCursor("task"), 2);
  interrupted.mock.restore();
  assert.deepEqual(new SqliteTasks(f.connection).conversationPage("task"), expected);
  f.connection.exec("CREATE TRIGGER no_repeat_conversation_backfill BEFORE INSERT ON conversation_rows BEGIN SELECT RAISE(ABORT, 'already indexed'); END");
  assert.deepEqual(new SqliteTasks(f.connection).conversationPage("task"), expected);
});
