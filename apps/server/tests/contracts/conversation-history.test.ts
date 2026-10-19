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

test("native environment updates stay out of live and stored conversations without resetting activity", t => {
  const f = fixture(t);
  const text = "<environment_context>\n<current_date>2026-01-01</current_date>\n</environment_context>";
  const contextPayload = { subtype: "followup", source: "local", text };
  const context = event("status", contextPayload);
  const events = [user("Continue"), message("Finished"), event("result", { is_error: false }), context];
  f.add(events);
  const log: LogItem[] = [];
  events.forEach((row, i) => appendHistoryEvent(log, row, i + 1));
  assert.equal(log.length, 3);
  const page = f.tasks.conversationPage("task");
  assert.equal(page.cursor, 4);
  assert.equal(page.activity, "ended");
  assert.ok(!JSON.stringify(page.transcript).includes("environment_context"));
  assert.equal(f.tasks.eventsAfterSeq("task", 0).length, 4, "raw records remain intact");
  const quoted = [user(text), user(`Explain ${text}`),
    event("status", { ...contextPayload, text: `\`\`\`xml\n${text}\n\`\`\`` }),
    event("status", { ...contextPayload, text: `${text}\nActual request` }),
    { ...context, agent: "claude" as const }];
  quoted.forEach((row, i) => appendHistoryEvent(log, row, i + 5));
  assert.equal(log.length, 8, "regular inputs and quoted context stay visible");
});

test("existing native context bubbles are rebuilt once while history and synchronization state survive", t => {
  const f = fixture(t);
  const text = "<environment_context><current_date>2026-01-01</current_date></environment_context>";
  const control = { owner: "shared" as const, connection: "connected" as const,
    home: "/provider", transcript: "/provider/session.jsonl", cursor: 1234, prefixHash: "unchanged" };
  f.tasks.setSessionControl("task", control);
  f.add([user("Continue"), message("Before"), event("status", { subtype: "followup", source: "local", text }), message("After")]);
  // Simulate a version-2 projection containing the previously visible metadata row.
  const bubble = { type: "message", key: 3, endSeq: 3, revision: 4,
    item: { key: 3, kind: "status", event: event("status", { subtype: "followup", source: "local", text }) } };
  f.connection.prepare("INSERT OR REPLACE INTO conversation_rows VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("task", 3, 3, 3, 4, JSON.stringify(bubble), JSON.stringify(bubble));
  f.connection.exec("UPDATE conversation_projection_version SET version = 2");
  const raw = f.tasks.eventsAfterSeq("task", 0);
  const upgraded = new SqliteTasks(f.connection);
  const page = upgraded.conversationPage("task");
  assert.ok(!JSON.stringify(page.transcript).includes("environment_context"));
  assert.equal(page.cursor, 4);
  assert.deepEqual(upgraded.eventsAfterSeq("task", 0), raw);
  assert.deepEqual(upgraded.getTask("task")?.sessionControl, control);
  assert.ok(JSON.stringify(page).includes("Before")); assert.ok(JSON.stringify(page).includes("After"));
  f.connection.exec("CREATE TRIGGER no_context_rebuild BEFORE INSERT ON conversation_rows BEGIN SELECT RAISE(ABORT, 'already upgraded'); END");
  assert.deepEqual(new SqliteTasks(f.connection).conversationPage("task"), page);
});

test("historical corrections skip hidden context when finding the preceding turn", t => {
  const f = fixture(t);
  f.add([user("Continue"), message("Before"), event("status", { subtype: "followup", source: "local",
    text: "<environment_context>updated</environment_context>" }), message("After")]);
  f.connection.prepare("UPDATE events SET payload_json = ? WHERE task_id = 'task' AND seq = 4")
    .run(JSON.stringify({ text: "Corrected", messageId: "After", phase: "final" }));
  const page = f.tasks.conversationPage("task");
  assert.ok(JSON.stringify(page).includes("Before")); assert.ok(JSON.stringify(page).includes("Corrected"));
  assert.ok(!JSON.stringify(page.transcript).includes("environment_context"));
  assert.equal(page.transcript!.filter(row => row.type === "message").length, 3);
});

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
  assert.equal(activity.summary!.label, "Activity · 400 tools");
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

test("live progress stays multiline and oversized previews retain bounded access to the full message", t => {
  const f = fixture(t);
  const text = "Inspecting the implementation.\n\n".repeat(20) + "Last progress paragraph.";
  f.add([event("assistant_text", { text, messageId: "progress", phase: "progress" })]);
  const activity = f.tasks.conversationPage("task").transcript![0];
  assert.equal(activity.type, "activity");
  if (activity.type !== "activity") return;
  assert.equal(activity.preview, text);
  assert.equal(activity.previewContent, undefined);

  const extra = "Large progress 😀 한글\n".repeat(20000);
  f.add([event("assistant_text", { text: extra, messageId: "progress", phase: "progress" })]);
  const page = f.tasks.conversationPage("task");
  bounded(page);
  const large = page.transcript![0];
  assert.equal(large.type, "activity");
  if (large.type !== "activity") return;
  const ref = large.previewContent!;
  assert.ok(ref);
  assert.ok(large.preview!.endsWith("…"));
  assert.deepEqual(large.items, []);
  let body = "", offset = 0;
  do {
    const chunk = f.tasks.conversationContent("task", ref.key, ref.version, offset, ref.member);
    bounded(chunk);
    body += chunk.chunk;
    if (chunk.nextOffset === null) break;
    offset = chunk.nextOffset;
  } while (true);
  assert.equal(JSON.parse(body).item.text, text + extra);
  f.add([event("result", {})]);
  const finished = f.tasks.conversationPage("task").transcript![0];
  assert.equal(finished.type, "activity");
  if (finished.type === "activity") {
    assert.equal(finished.preview, undefined);
    assert.equal(finished.previewContent, undefined);
  }
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

test("Trace lists contain bounded metadata and hydrate only the selected operation across reply boundaries", t => {
  const f = fixture(t);
  f.add([user("Inspect"), event("tool_call", { id: "one", name: "bash", command: "pnpm test" }),
    message("Intervening answer"), event("tool_result", { tool_use_id: "one", output: "Only load this when opened", exit_code: 0 }),
    event("tool_call", { id: "two", name: "Read" }), event("tool_result", { tool_use_id: "two", output: "Unrelated output" })]);
  const activity = f.tasks.conversationPage("task").transcript!.find(row => row.type === "activity")!;
  const prepare = f.connection.prepare.bind(f.connection);
  const noRaw = t.mock.method(f.connection, "prepare", (sql: string) => {
    assert.ok(!sql.includes("FROM events"), "step lists must use the retained summary projection");
    return prepare(sql);
  });
  const steps = f.tasks.conversationSteps("task", activity.key);
  bounded(steps);
  assert.equal(steps.steps[0].title, "pnpm test");
  assert.equal(steps.steps[0].state, "completed");
  assert.ok(!JSON.stringify(steps).includes("Only load"));
  assert.ok(!JSON.stringify(steps).includes("members"));
  noRaw.mock.restore();
  const detail = f.tasks.conversationStepDetails("task", activity.key, steps.steps[0].key);
  bounded(detail);
  assert.ok(JSON.stringify(detail).includes("Only load this when opened"));
  assert.ok(!JSON.stringify(detail).includes("Unrelated output"));
  assert.throws(() => f.tasks.conversationStepDetails("other-task", activity.key, steps.steps[0].key), /no longer available/);
});

test("Trace operation pagination, oversized output and raw execution records preserve all information", t => {
  const f = fixture(t), output = "Unicode 😀 한글\n".repeat(10000);
  f.add([user("Inspect"), ...Array.from({ length: 70 }, (_, i) => [
    event("tool_call", { id: `a-${i}`, name: "Read", input: { path: `file-${i}` } }),
    event("tool_result", { tool_use_id: `a-${i}`, output: i === 0 ? output : `Result ${i}` }),
  ]).flat(), event("result", {}), event("status", { subtype: "process_exit", code: 0 })]);
  const activity = f.tasks.conversationPage("task").transcript!.find(row => row.type === "activity")!;
  const first = f.tasks.conversationSteps("task", activity.key), next = f.tasks.conversationSteps("task", activity.key, first.nextAfter!);
  assert.equal(first.steps.length, 50); assert.equal(next.steps.length, 20); assert.equal(next.nextAfter, null);
  const details = f.tasks.conversationStepDetails("task", activity.key, first.steps[0].key);
  const ref = details.items.find(item => item.content)!.content!;
  let offset = 0, text = "";
  do {
    const chunk = f.tasks.conversationContent("task", ref.key, ref.version, offset, ref.member);
    text += chunk.chunk;
    if (chunk.nextOffset === null) break;
    offset = chunk.nextOffset;
  } while (true);
  assert.equal(JSON.parse(text).item.event.payload.output, output);
  let before: number | undefined;
  const records: import("@palmagent/shared").ExecutionRecord[] = [];
  do {
    const page = f.tasks.executionRecords("task", before); bounded(page);
    records.unshift(...page.records); before = page.before ?? undefined;
  } while (before !== undefined);
  assert.equal(records.length, 143);
  assert.equal(new Set(records.map(record => record.key)).size, 143);
  assert.ok(records.some(record => record.body?.includes("process_exit")));
  const large = records.find(record => !record.body)!;
  offset = 0; text = "";
  do {
    const chunk = f.tasks.executionRecordContent("task", large.key, large.version, offset); bounded(chunk);
    text += chunk.chunk;
    if (chunk.nextOffset === null) break;
    offset = chunk.nextOffset;
  } while (true);
  assert.equal(JSON.parse(text).payload.output, output);
  assert.throws(() => f.tasks.executionRecordContent("other-task", large.key, large.version, 0), /no longer available/);
});


test("late classification retains the disclosure identity while its ordering key changes", t => {
  const f = fixture(t);
  f.add([event("assistant_text", { text: "Inspecting files", messageId: "progress" }), event("tool_call", { id: "one", name: "Read" })]);
  const before = f.tasks.conversationPage("task").transcript!.find(row => row.type === "activity")!;
  f.add([event("status", { subtype: "assistant_message", messageId: "progress", phase: "progress" })]);
  const after = f.tasks.conversationPage("task").transcript!.find(row => row.type === "activity")!;
  assert.equal(before.type, "activity"); assert.equal(after.type, "activity");
  if (before.type !== "activity" || after.type !== "activity") return;
  assert.notEqual(before.key, after.key);
  assert.equal(before.disclosureKey, after.disclosureKey);
  assert.ok(f.tasks.conversationSteps("task", after.key).steps.some(step => step.key === 2));
});


test("existing conversation projections upgrade to Trace metadata once without losing original output", t => {
  const f = fixture(t);
  f.add([user("Existing"), event("tool_call", { id: "one", name: "Read", input: { path: "existing.txt" } }),
    event("tool_result", { tool_use_id: "one", output: "Preserved output" })]);
  f.connection.exec(`DELETE FROM event_compact_version; DELETE FROM conversation_projection_version;
    UPDATE event_compact_payloads SET payload_json = json_remove(payload_json, '$.traceTitle');
    UPDATE conversation_rows SET body_json = json_remove(body_json, '$.operations', '$.disclosureKey') WHERE body_json IS NOT NULL;`);
  const upgraded = new SqliteTasks(f.connection);
  const activity = upgraded.conversationPage("task").transcript!.find(row => row.type === "activity")!;
  const step = upgraded.conversationSteps("task", activity.key).steps[0];
  assert.equal(step.title, "Read existing.txt");
  assert.equal(step.state, "completed");
  assert.ok(JSON.stringify(upgraded.conversationStepDetails("task", activity.key, step.key)).includes("Preserved output"));
  f.connection.exec("CREATE TRIGGER no_trace_rebuild BEFORE INSERT ON conversation_rows BEGIN SELECT RAISE(ABORT, 'already upgraded'); END");
  assert.deepEqual(new SqliteTasks(f.connection).conversationPage("task"), upgraded.conversationPage("task"));
});
