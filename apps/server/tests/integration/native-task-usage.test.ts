import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Db } from "../../src/composition/database.js";
import { CONVERSATION_PAGE_BYTES, CONVERSATION_ITEM_BYTES, CONVERSATION_PROJECTION_VERSION } from "@palmagent/shared";
import { NativeTaskTranscript } from "../../src/modules/tasks/adapters/outbound/native-task-transcript.js";
import { NativeTaskActivity } from "../../src/modules/tasks/adapters/outbound/native-task-activity.js";
import { NativeTaskUsage } from "../../src/modules/tasks/adapters/outbound/native-task-usage.js";
import { applicationRequest, applicationSocket } from "../../src/platform/ipc/application-runtime.js";
import { ApplicationError } from "../../src/kernel/errors.js";

// One real runtime and the actual product schema exercise the cross-language read boundary.
// The same fixture covers usage accounting, activity expansion and transcript pagination without a provider or browser.
test("native Task reads preserve accounting, activity, transcript pagination and committed snapshots", { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "native-task-usage-"));
  const release = join(root, "releases/fixture"), node = join(root, "runtimes/node"), ready = join(root, "ready");
  mkdirSync(release, { recursive: true }); mkdirSync(dirname(node), { recursive: true });
  copyFileSync(process.execPath, node);
  const db = new Db(join(root, "palmagent.db")), writer = new Database(db.path);
  const client = new NativeTaskUsage(root);
  const activity = new NativeTaskActivity(root);
  const transcript = new NativeTaskTranscript(root);
  const binary = fileURLToPath(new URL("../../../../target/debug/palmagent-runtime", import.meta.url));
  const hosts: ChildProcess[] = [];
  let socketDirectory: string | undefined;
  let host: ChildProcess;
  const stop = async (child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit"); child.kill(signal); await exited;
  };
  t.after(async () => {
    for (const child of hosts) await stop(child, "SIGKILL");
    writer.close(); db.close();
    if (socketDirectory) rmSync(socketDirectory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  const start = async () => {
    rmSync(ready, { force: true });
    host = spawn(binary, ["serve", "--data-dir", root, "--release", release, "--node", node], {
      env: { PATH: process.env.PATH, PALMAGENT_HOST_READY: ready, PALMAGENT_HOME: root, DISPATCHER_DB: db.path },
      stdio: ["ignore", "ignore", "pipe"],
    });
    hosts.push(host);
    let diagnostic = "";
    host.stderr!.on("data", chunk => { diagnostic = (diagnostic + chunk).slice(-4096); });
    for (let i = 0; !existsSync(ready); i++) {
      assert.equal(host.exitCode, null, diagnostic);
      assert.equal(host.signalCode, null, diagnostic);
      assert(i < 200, `Runtime readiness timed out: ${diagnostic}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    socketDirectory = dirname(applicationSocket(root));
    const health = await applicationRequest(root, "/health");
    assert.equal(health.status, 200);
    assert.equal((health.value as { taskUsage: number }).taskUsage, 1);
    assert.equal((health.value as { taskActivityDetails: number }).taskActivityDetails, 1);
    assert.equal((health.value as { taskTranscript: number }).taskTranscript, 1);
  };
  const wire = (value: unknown) => JSON.parse(JSON.stringify(value));
  const same = async () => {
    const expected = wire(db.usageByAgent());
    assert.deepEqual(wire(await client.usageByAgent()), expected);
    assert.deepEqual((await applicationRequest(root, "/v1/tasks/usage")).value, { usage: expected });
    return expected;
  };
  db.insertRepo({ id: "space", name: "Fixture", path: root, vcs: "none", defaultBaseRef: "", createdAt: 1 });
  const task = (id: string, agent: "claude" | "codex") => db.insertTask({ taskId: id, repoId: "space", agent, prompt: "fixture", permission: "default", status: "idle", interrupted: false, createdAt: 1, updatedAt: 1, lastActivityAt: 1 });
  task("claude", "claude"); task("codex", "codex");
  const raw = (id: string, payload: string) => {
    const event = db.insertEvent(id, "result", {}, 1);
    writer.prepare("UPDATE events SET payload_json = ? WHERE id = ?").run(payload, event.id);
    return event.id;
  };
  raw("claude", '{"total_cost_usd":0,"usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":30,"output_tokens":0}}');
  const first = raw("codex", '{"usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":5,"reasoning_output_tokens":2}}');
  for (const payload of [
    '{', 'null', '[]',
    '{"duration_ms":-1,"usage":{"input_tokens":"5","cached_input_tokens":-1,"output_tokens":null}}',
    '{"total_cost_usd":1e400,"duration_ms":2,"usage":{"input_tokens":3}}',
    '{"duration_ms":9,"duration_ms":4,"usage":{"input_tokens":1,"input_tokens":2}}',
    '{"result":"\\ud800","usage":{"input_tokens":1}}',
  ]) raw("codex", payload);
  await start();
  const initial = await same();
  assert.equal(initial[0].inputTokens, 60); assert.equal(initial[0].cachedInputTokens, 20);
  assert(initial[0].reported.includes("totalCostUsd")); assert(!initial[0].reported.includes("durationMs"));
  assert.equal(initial[1].inputTokens, 106); assert.equal(initial[1].durationMs, 6);
  const returned = await client.usageByAgent(); returned[0].inputTokens = 999; returned[0].reported!.length = 0;
  await same();

  // A separate connection cannot leak uncommitted values or a reused rolled-back revision.
  writer.exec("BEGIN IMMEDIATE");
  writer.prepare("UPDATE events SET payload_json = ? WHERE id = ?").run('{"usage":{"input_tokens":999}}', first);
  assert.deepEqual(wire(await client.usageByAgent()), initial);
  await stop(host!); await start(); // cold native cache still sees only committed data
  assert.deepEqual(wire(await client.usageByAgent()), initial);
  writer.exec("ROLLBACK");
  writer.prepare("UPDATE events SET payload_json = ? WHERE id = ?").run('{"usage":{"input_tokens":12}}', first);
  assert.equal((await same())[1].inputTokens, 18);
  writer.prepare("UPDATE events SET kind = 'assistant_text' WHERE id = ?").run(first);
  await same();
  writer.prepare("DELETE FROM events WHERE id = ?").run(first); await same();
  writer.prepare("UPDATE tasks SET agent = 'claude' WHERE id = 'codex'").run(); await same();
  task("empty", "codex"); await same();
  raw("empty", '{"total_cost_usd":1e308}'); raw("empty", '{"total_cost_usd":1e308}');
  assert.equal((await same())[1].totalCostUsd, null, "aggregate overflow preserves the legacy JSON representation");
  writer.exec("ALTER TABLE task_usage_revision RENAME TO temporarily_unavailable_usage");
  await assert.rejects(client.usageByAgent(), error => error instanceof ApplicationError && error.code === "service_unavailable");
  writer.exec("ALTER TABLE temporarily_unavailable_usage RENAME TO task_usage_revision");
  await same();
  // Activity is an inclusive range, independent of usage and history page sizes.
  const details = async (id: string, from: number, through: number) => {
    const expected = wire(db.activityDetails(id, from, through));
    assert.deepEqual(wire(await activity.activityDetails(id, from, through)), expected);
    return expected;
  };
  const activityTask = "activity &/?한글"; task(activityTask, "codex");
  await details(activityTask, 1, 99); // empty cursor is zero, even when from is positive
  const firstTool = db.insertEvent(activityTask, "tool_call", { command: "fixture", nested: [null, false, 0] }, 10);
  db.insertEvent(activityTask, "assistant_text", { text: "not activity" }, 11);
  for (let i = 0; i < 201; i++) db.insertEvent(activityTask, "tool_result", { output: `result ${i}` }, i + 12);
  const activityBefore = await details(activityTask, 1, 9999);
  assert.equal(activityBefore.events.length, 202, "activity must not stop at a history page");
  assert.equal(activityBefore.through, activityBefore.cursor);
  await details(activityTask, firstTool.seq, firstTool.seq);
  await details(activityTask, 2, 2); // a range containing only a non-tool event
  await details(activityTask, 9999, 9999);
  assert.equal((await applicationRequest(root, "/v1/tasks/activity-details?taskId=x&from=2&through=1")).status, 400);
  assert.equal((await applicationRequest(root, "/v1/tasks/activity-details?taskId=x&from=0&through=1")).status, 400);

  writer.exec("BEGIN IMMEDIATE");
  writer.prepare("UPDATE events SET payload_json = ? WHERE id = ?").run('{"output":"uncommitted"}', firstTool.id);
  assert.deepEqual(wire(await activity.activityDetails(activityTask, 1, 9999)), activityBefore);
  await stop(host!); await start();
  assert.deepEqual(wire(await activity.activityDetails(activityTask, 1, 9999)), activityBefore);
  writer.exec("ROLLBACK");
  writer.prepare("UPDATE tasks SET session_id = ?, agent = 'claude' WHERE id = ?").run("resumed-session", activityTask);
  for (const payload of [
    'null', '[]', '42', '"text"',
    '{"key":1,"key":2,"overflow":1e400,"surrogate":"\\ud800","text":"한글 😀"}',
    '['.repeat(200) + '0' + ']'.repeat(200),
  ]) {
    writer.prepare("UPDATE events SET payload_json = ? WHERE id = ?").run(payload, firstTool.id);
    await details(activityTask, firstTool.seq, firstTool.seq);
  }
  // A single historical tool result may exceed the private control response limit.
  // This is the smallest fixture that catches silently introducing that limit here.
  writer.prepare("UPDATE events SET payload_json = ? WHERE id = ?").run(JSON.stringify({ output: "x".repeat(16 * 1024 * 1024) }), firstTool.id);
  await details(activityTask, firstTool.seq, firstTool.seq);
  await assert.rejects(applicationRequest(root, `/v1/tasks/activity-details?taskId=${encodeURIComponent(activityTask)}&from=1&through=1`), /too large/,
    "other control transport callers retain their response limit");
  writer.prepare("UPDATE events SET payload_json = ? WHERE id = ?").run('{', firstTool.id);
  await assert.rejects(activity.activityDetails(activityTask, 1, 1), error => error instanceof ApplicationError && error.code === "service_unavailable");
  writer.prepare("UPDATE events SET payload_json = ? WHERE id = ?").run('{"output":"committed"}', firstTool.id);
  await details(activityTask, 1, 9999);
  writer.prepare("DELETE FROM events WHERE id = ?").run(firstTool.id);
  await details(activityTask, 1, 9999);
  writer.exec("ALTER TABLE events RENAME TO unavailable_events");
  await assert.rejects(activity.activityDetails(activityTask, 1, 1), error => error instanceof ApplicationError && error.code === "service_unavailable");
  writer.exec("ALTER TABLE unavailable_events RENAME TO events");
  await details(activityTask, 1, 9999);
  const unavailable = (error: unknown) => error instanceof ApplicationError && error.code === "service_unavailable";
  const page = async (id: string, before?: number) => {
    const expected = db.conversationPage(id, before); // the retained writer refreshes before reading
    assert.deepEqual(await transcript.conversationPage(id, before), expected);
    assert(Buffer.byteLength(JSON.stringify(expected)) <= CONVERSATION_PAGE_BYTES);
    return expected;
  };
  const changes = async (id: string, after: number, through?: number, afterKey?: number) => {
    const expected = db.conversationChanges(id, after, through, afterKey);
    assert.deepEqual(await transcript.conversationChanges(id, after, through, afterKey), expected);
    assert(Buffer.byteLength(JSON.stringify(expected)) <= CONVERSATION_PAGE_BYTES);
    return expected;
  };
  const transcriptTask = "transcript &/?한글"; task(transcriptTask, "codex");
  await page(transcriptTask); await changes(transcriptTask, 0); await changes(transcriptTask, 99);
  for (let i = 0; i < 45; i++) db.insertEvent(transcriptTask, "assistant_text", {
    text: `Message ${i} 한글 😀 \ud800`, messageId: `message-${i}`, phase: "final",
  }, i);
  const initialPage = await page(transcriptTask);
  assert.equal(initialPage.transcript!.length, 30);
  const earlier = await page(transcriptTask, initialPage.before!);
  assert.equal(earlier.transcript!.length, 15); assert.equal(earlier.before, null);
  await page(transcriptTask, 1);
  let after = 0, afterKey: number | undefined;
  const keys: number[] = [];
  do {
    const result = await changes(transcriptTask, after, undefined, afterKey);
    keys.push(...result.transcript!.map(row => row.key));
    if (result.nextAfter === null) break;
    assert.equal(result.nextAfter, initialPage.cursor, "resume within the same revision");
    after = result.nextAfter; afterKey = result.nextKey;
  } while (true);
  assert.deepEqual(keys, Array.from({ length: 45 }, (_, i) => i + 1));
  assert.equal((await changes(transcriptTask, 0, initialPage.cursor - 1)).activity, undefined);
  await changes(transcriptTask, initialPage.cursor, 9999);
  writer.prepare("DELETE FROM events WHERE task_id = ? AND seq = 5").run(transcriptTask);
  db.insertEvent(transcriptTask, "status", { subtype: "followup", text: "Continue" }, 100);
  const correction = await changes(transcriptTask, initialPage.cursor);
  assert(correction.transcript!.some(row => row.key === 5 && row.item === null), "deleted rows remain tombstone patches");
  const committed = await page(transcriptTask);
  writer.exec("BEGIN IMMEDIATE");
  writer.prepare("UPDATE conversation_state SET cursor = 999, activity = 'blocked' WHERE task_id = ?").run(transcriptTask);
  writer.prepare("UPDATE conversation_rows SET wire_json = NULL WHERE task_id = ?").run(transcriptTask);
  assert.deepEqual(await transcript.conversationPage(transcriptTask), committed);
  await stop(host!); await start();
  assert.deepEqual(await transcript.conversationPage(transcriptTask), committed);
  writer.exec("ROLLBACK");
  await page(transcriptTask);

  // Six normal-sized canonical projection items exactly fill the byte budget. Change
  // envelopes take extra bytes, and one extra UTF-8 byte must move a page boundary.
  const budgetTask = "byte-budget"; task(budgetTask, "claude");
  for (let i = 0; i < 6; i++) db.insertEvent(budgetTask, "assistant_text", {
    text: "한".repeat(14_300), messageId: `budget-${i}`, phase: "final",
  }, i);
  db.prepareConversation(budgetTask);
  const budgetRows = writer.prepare("SELECT seq, wire_json FROM conversation_rows WHERE task_id = ? ORDER BY seq").all(budgetTask) as { seq: number; wire_json: string }[];
  const used = budgetRows.reduce((sum, row) => sum + Buffer.byteLength(row.wire_json), 0);
  const edge = JSON.parse(budgetRows[0].wire_json);
  edge.item.text += "x".repeat(CONVERSATION_PAGE_BYTES - 1024 - used);
  writer.prepare("UPDATE conversation_rows SET wire_json = ? WHERE task_id = ? AND seq = ?").run(JSON.stringify(edge), budgetTask, budgetRows[0].seq);
  assert.equal((await page(budgetTask)).transcript!.length, 6);
  assert.equal((await changes(budgetTask, 0)).transcript!.length, 5);
  assert(Buffer.byteLength(JSON.stringify(edge)) <= CONVERSATION_ITEM_BYTES);
  edge.item.text += "x";
  writer.prepare("UPDATE conversation_rows SET wire_json = ? WHERE task_id = ? AND seq = ?").run(JSON.stringify(edge), budgetTask, budgetRows[0].seq);
  assert.equal((await page(budgetTask)).transcript!.length, 5);
  writer.prepare("UPDATE conversation_rows SET wire_json = ? WHERE task_id = ? AND seq = ?").run("{", budgetTask, budgetRows[0].seq);
  await assert.rejects(transcript.conversationPage(budgetTask, 2), unavailable);
  writer.prepare("UPDATE conversation_rows SET wire_json = ? WHERE task_id = ? AND seq = ?").run(JSON.stringify(edge), budgetTask, budgetRows[0].seq);
  writer.exec("UPDATE conversation_projection_version SET version = 0");
  await assert.rejects(transcript.conversationPage(transcriptTask), unavailable);
  await assert.rejects(transcript.conversationChanges(transcriptTask, 0), unavailable);
  writer.prepare("UPDATE conversation_projection_version SET version = ?").run(CONVERSATION_PROJECTION_VERSION);
  writer.exec("ALTER TABLE conversation_rows RENAME TO unavailable_projection");
  await assert.rejects(transcript.conversationPage(transcriptTask), unavailable);
  writer.exec("ALTER TABLE unavailable_projection RENAME TO conversation_rows");
  await page(transcriptTask);
  assert.equal((await applicationRequest(root, "/v1/tasks/transcript/changes?taskId=x&after=2&through=1")).status, 400);
  assert.equal((await applicationRequest(root, "/v1/tasks/transcript/page?taskId=x&before=0")).status, 400);
  db.deleteRepo("space"); assert.deepEqual(await client.usageByAgent(), []);
  await page(transcriptTask); await changes(transcriptTask, 0);
  await details(activityTask, 1, 9999);

  await stop(host!);
  await assert.rejects(client.usageByAgent(), error => error instanceof ApplicationError && error.code === "service_unavailable");
  await assert.rejects(activity.activityDetails(activityTask, 1, 1), error => error instanceof ApplicationError && error.code === "service_unavailable");
  await assert.rejects(transcript.conversationPage(transcriptTask), unavailable);
  await assert.rejects(transcript.conversationChanges(transcriptTask, 0), unavailable);
  // The legacy reader remains usable for rollback; native failures never silently call it.
  assert.deepEqual(db.usageByAgent(), []);
  assert.deepEqual(db.activityDetails(activityTask, 1, 1), { events: [], from: 1, through: 0, cursor: 0 });
});
