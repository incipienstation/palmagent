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
test("native private and public Task reads preserve auth, accounting, pagination and committed snapshots", { timeout: 30_000 }, async t => {
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
  let publicPort = 0;
  const sessionTtlMs = 60_000;
  const directSettings = { port: 0, authEnabled: true, cookieName: "palmagent_session", sessionTtlMs, authOrigin: "https://localhost" };
  db.createSession("read-session", Date.now(), Date.now() + sessionTtlMs);
  const publicRead = async (path: string, cookie = "palmagent_session=read-session", method = "GET") => {
    const response = await fetch(`http://${[127, 0, 0, 1].join(".")}:${publicPort}${path}`, { method, headers: { cookie, origin: "https://localhost" }, signal: AbortSignal.timeout(5000) });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const value = method === "HEAD" ? null : await response.json();
    return { status: response.status, value };
  };
  const publicSame = async (path: string, value: unknown) => {
    const response = await publicRead(path);
    assert.equal(response.status, 200, JSON.stringify(response.value));
    assert.deepEqual(response.value, wire(value));
  };
  const publicTaskSame = async (id: string, path: string, value: unknown) => {
    if (db.getTask(id)) await publicSame(path, value);
    else assert.deepEqual(await publicRead(path), { status: 404, value: { error: `no such task: ${id}`, code: "not_found" } });
  };
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
    assert.equal((health.value as { taskTranscriptSteps: number }).taskTranscriptSteps, 1);
    assert.equal((health.value as { taskReadHttp: number }).taskReadHttp, 1);
    const configured = await applicationRequest(root, "/v1/task-reads/http", "POST", directSettings);
    assert.equal(configured.status, 200);
    publicPort = (configured.value as { port: number }).port;
  };
  const wire = (value: unknown) => JSON.parse(JSON.stringify(value));
  const same = async () => {
    const expected = wire(db.usageByAgent());
    assert.deepEqual(wire(await client.usageByAgent()), expected);
    assert.deepEqual((await applicationRequest(root, "/v1/tasks/usage")).value, { usage: expected });
    await publicSame("/api/usage", { usage: expected });
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
  for (const path of ["/api/usage", "/api/tasks/claude/history?format=transcript", "/api/tasks/claude/history/changes?format=transcript&after=0", "/api/tasks/claude/history/steps?key=1", "/api/tasks/claude/history/details?from=1&through=1"]) {
    assert.deepEqual(await publicRead(path, ""), { status: 401, value: { error: "unauthorized" } });
  }
  for (const path of ["/api/health", "/api/tasks", "/api/tasks/claude/history", "/api/tasks/claude/history/step-details?key=1&step=1", "/api/stream", "/v1/tasks/usage", "/v1/routines"]) {
    assert.equal((await publicRead(path)).status, 404, "unmigrated/control routes must not be exposed by the public read listener");
  }
  assert.equal((await publicRead("/api/usage", undefined, "HEAD")).status, 404);
  assert.equal((await publicRead("/v1/task-reads/http", undefined, "POST")).status, 404);
  db.createSession("expired", Date.now(), Date.now() - 1);
  db.createSession("old-login", Date.now() - sessionTtlMs, Date.now() + sessionTtlMs);
  for (const cookie of ["palmagent_session=expired", "palmagent_session=old-login", "palmagent_session=missing"]) assert.equal((await publicRead("/api/usage", cookie)).status, 401);
  db.createSession("revocable", Date.now(), Date.now() + sessionTtlMs);
  assert.equal((await publicRead("/api/usage", "palmagent_session=revocable")).status, 200);
  db.deleteSession("revocable");
  assert.equal((await publicRead("/api/usage", "palmagent_session=revocable")).status, 401);
  for (const cookie of ['palmagent_session=read%2Dsession', 'palmagent_session="read-session"', 'palmagent_session=read-session; palmagent_session=missing']) {
    assert.equal((await publicRead("/api/usage", cookie)).status, 200);
  }
  assert.equal((await publicRead("/api/usage", "palmagent_session=missing; palmagent_session=read-session")).status, 401);
  assert.deepEqual(await publicRead("/api/tasks/missing/history?format=transcript"), { status: 404, value: { error: "no such task: missing", code: "not_found" } });
  for (const [query, field, code] of [["before=0", "before", "custom"], ["before=-1", "before", "invalid_format"], ["before=9007199254740992", "before", "custom"], ["details=no", "details", "invalid_value"]]) {
    assert.deepEqual(await publicRead(`/api/tasks/claude/history?format=transcript&${query}`), { status: 400, value: { error: `invalid request: ${field} (${code})`, code: "bad_request" } });
  }
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
    await publicTaskSame(id, `/api/tasks/${encodeURIComponent(id)}/history/details?from=${from}&through=${through}`, expected);
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
    '{"negativeZero":-0,"underflow":-1e-400,"largeInteger":9007199254740993}',
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
    await publicTaskSame(id, `/api/tasks/${encodeURIComponent(id)}/history?format=transcript${before === undefined ? "" : `&before=${before}`}`, expected);
    assert(Buffer.byteLength(JSON.stringify(expected)) <= CONVERSATION_PAGE_BYTES);
    return expected;
  };
  const changes = async (id: string, after: number, through?: number, afterKey?: number) => {
    const expected = db.conversationChanges(id, after, through, afterKey);
    assert.deepEqual(await transcript.conversationChanges(id, after, through, afterKey), expected);
    const query = new URLSearchParams({ format: "transcript", after: String(after) });
    if (through !== undefined) query.set("through", String(through));
    if (afterKey !== undefined) query.set("afterKey", String(afterKey));
    await publicTaskSame(id, `/api/tasks/${encodeURIComponent(id)}/history/changes?${query}`, expected);
    assert(Buffer.byteLength(JSON.stringify(expected)) <= CONVERSATION_PAGE_BYTES);
    return expected;
  };
  const transcriptTask = "transcript &/?한글"; task(transcriptTask, "codex");
  await page(transcriptTask); await changes(transcriptTask, 0);
  await changes(transcriptTask, 99);
  for (let i = 0; i < 45; i++) db.insertEvent(transcriptTask, "assistant_text", {
    text: `Message ${i} 한글 😀 \ud800`, messageId: `message-${i}`, phase: "final",
  }, i);
  assert.equal((await publicRead(`/api/tasks/${encodeURIComponent(transcriptTask)}/history?format=transcript`)).status, 503,
    "a dirty projection must never be silently served by the direct reader");
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
  task("atomic-projection", "codex");
  db.appendAgentEvents("atomic-projection", [{ taskId: "atomic-projection", agent: "codex", kind: "assistant_text", payload: { text: "committed together", messageId: "atomic", phase: "final" }, ts: 1 }]);
  const atomic = await publicRead("/api/tasks/atomic-projection/history?format=transcript");
  assert.equal(atomic.status, 200);
  assert.equal((atomic.value as { cursor: number }).cursor, 1);
  await publicSame(`/api/tasks/${encodeURIComponent(transcriptTask)}/history?format=transcript&before=1&before=9999`, db.conversationPage(transcriptTask, 1));
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
  const stepsTask = "steps &/?한글"; task(stepsTask, "codex");
  for (let i = 0; i < 53; i++) {
    db.insertEvent(stepsTask, "tool_call", { id: `call-${i}`, name: "bash", command: `check ${i}` }, i);
    if (i < 52) db.insertEvent(stepsTask, "tool_result", { tool_use_id: `call-${i}`, output: "private detail", exit_code: i === 1 ? 1 : 0 }, i);
  }
  const parent = (await page(stepsTask)).transcript!.find(row => row.type === "activity")!.key;
  const steps = async (id: string, key: number, after?: number) => {
    const expected = db.conversationSteps(id, key, after);
    const actual = await transcript.conversationSteps(id, key, after);
    assert.deepEqual(actual, expected);
    await publicTaskSame(id, `/api/tasks/${encodeURIComponent(id)}/history/steps?key=${key}${after === undefined ? "" : `&after=${after}`}`, expected);
    assert(actual.steps.every(step => !("members" in step)), "member references stay in the projection");
    assert(!JSON.stringify(actual).includes("private detail"));
    return actual;
  };
  const firstSteps = await steps(stepsTask, parent);
  assert.equal(firstSteps.steps.length, 50);
  const lastSteps = await steps(stepsTask, parent, firstSteps.nextAfter!);
  assert.equal(lastSteps.steps.length, 3); assert.equal(lastSteps.nextAfter, null);
  assert.equal(lastSteps.steps.at(-1)!.state, "running");
  assert.equal(firstSteps.steps[1].state, "error");
  await steps(stepsTask, parent, lastSteps.steps.at(-1)!.key);
  assert.deepEqual((await steps(transcriptTask, 1)).steps, [], "message parents have no operations");
  const missing = (error: unknown) => error instanceof ApplicationError && error.code === "not_found" && error.message === "Conversation item is no longer available.";
  assert.throws(() => db.conversationSteps(stepsTask, 9999), missing);
  await assert.rejects(transcript.conversationSteps(stepsTask, 9999), missing);
  const stored = writer.prepare("SELECT body_json FROM conversation_rows WHERE task_id = ? AND seq = ?").get(stepsTask, parent) as { body_json: string };
  const body = JSON.parse(stored.body_json);
  body.operations.reverse();
  body.operations[0].title = "한글 😀 \ud800";
  body.operations[0].extension = { value: "future summary field" };
  const setBody = (value: string | null) => writer.prepare("UPDATE conversation_rows SET body_json = ? WHERE task_id = ? AND seq = ?").run(value, stepsTask, parent);
  setBody(JSON.stringify(body));
  await steps(stepsTask, parent); await steps(stepsTask, parent, firstSteps.nextAfter!);
  const committedSteps = await steps(stepsTask, parent);
  writer.exec("BEGIN IMMEDIATE");
  writer.prepare("UPDATE conversation_rows SET revision = 999, body_json = NULL WHERE task_id = ? AND seq = ?").run(stepsTask, parent);
  assert.deepEqual(await transcript.conversationSteps(stepsTask, parent), committedSteps);
  await stop(host!); await start();
  assert.deepEqual(await transcript.conversationSteps(stepsTask, parent), committedSteps);
  writer.exec("ROLLBACK");
  setBody(JSON.stringify({ ...body, operations: null })); await steps(stepsTask, parent);
  setBody(null); await assert.rejects(transcript.conversationSteps(stepsTask, parent), missing);
  setBody("{"); await assert.rejects(transcript.conversationSteps(stepsTask, parent), unavailable);
  setBody(stored.body_json);
  db.insertEvent(stepsTask, "tool_result", { tool_use_id: "call-52", output: "private detail", exit_code: 0 }, 100);
  assert.equal((await steps(stepsTask, parent, firstSteps.nextAfter!)).steps.at(-1)!.state, "completed");
  assert.equal((await applicationRequest(root, "/v1/tasks/transcript/steps?taskId=x&key=0")).status, 400);
  assert.equal((await applicationRequest(root, "/v1/tasks/transcript/steps?taskId=x&key=1&after=-1")).status, 400);
  writer.exec("UPDATE conversation_projection_version SET version = 0");
  await assert.rejects(transcript.conversationSteps(stepsTask, parent), unavailable);
  await assert.rejects(transcript.conversationPage(transcriptTask), unavailable);
  await assert.rejects(transcript.conversationChanges(transcriptTask, 0), unavailable);
  writer.prepare("UPDATE conversation_projection_version SET version = ?").run(CONVERSATION_PROJECTION_VERSION);
  writer.exec("ALTER TABLE conversation_rows RENAME TO unavailable_projection");
  await assert.rejects(transcript.conversationPage(transcriptTask), unavailable);
  writer.exec("ALTER TABLE unavailable_projection RENAME TO conversation_rows");
  await page(transcriptTask);
  assert.equal((await applicationRequest(root, "/v1/tasks/transcript/changes?taskId=x&after=2&through=1")).status, 400);
  assert.equal((await applicationRequest(root, "/v1/tasks/transcript/page?taskId=x&before=0")).status, 400);
  const retained = await applicationRequest(root, "/v1/task-reads/http", "POST", directSettings);
  assert.deepEqual(retained.value, { enabled: true, port: publicPort }, "identical owner configuration retains the listener");
  assert.equal((await applicationRequest(root, "/v1/task-reads/http", "POST", { ...directSettings, authOrigin: "http://localhost" })).status, 503);
  assert.equal((await publicRead("/api/usage")).status, 200, "invalid configuration must not disable the active listener");
  writer.exec("ALTER TABLE auth_sessions RENAME TO unavailable_sessions");
  assert.equal((await publicRead("/api/usage")).status, 503, "session lookup failures fail closed");
  writer.exec("ALTER TABLE unavailable_sessions RENAME TO auth_sessions");
  db.deleteRepo("space"); assert.deepEqual(await client.usageByAgent(), []);
  await page(transcriptTask); await changes(transcriptTask, 0);
  await assert.rejects(transcript.conversationSteps(stepsTask, parent), missing);
  await details(activityTask, 1, 9999);

  const disabled = await applicationRequest(root, "/v1/task-reads/http", "POST", null);
  assert.deepEqual(disabled.value, { enabled: false, port: null });
  await assert.rejects(publicRead("/api/usage"));
  assert.deepEqual(await client.usageByAgent(), [], "disabling direct reads leaves the mediated path usable");
  const enabled = await applicationRequest(root, "/v1/task-reads/http", "POST", directSettings);
  publicPort = (enabled.value as { port: number }).port;
  await publicSame("/api/usage", { usage: [] });
  await stop(host!);
  await assert.rejects(publicRead("/api/usage"));
  await assert.rejects(client.usageByAgent(), error => error instanceof ApplicationError && error.code === "service_unavailable");
  await assert.rejects(activity.activityDetails(activityTask, 1, 1), error => error instanceof ApplicationError && error.code === "service_unavailable");
  await assert.rejects(transcript.conversationPage(transcriptTask), unavailable);
  await assert.rejects(transcript.conversationChanges(transcriptTask, 0), unavailable);
  await assert.rejects(transcript.conversationSteps(stepsTask, parent), unavailable);
  // The legacy reader remains usable for rollback; native failures never silently call it.
  assert.deepEqual(db.usageByAgent(), []);
  assert.deepEqual(db.activityDetails(activityTask, 1, 1), { events: [], from: 1, through: 0, cursor: 0 });
});
