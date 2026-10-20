import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { SharedSessionConnection, SharedSessionEvent, SharedSessionSnapshot } from "../../src/modules/agents/api.js";
import { createTaskService } from "../../src/composition/task-service.js";
import { Db } from "../../src/composition/database.js";
import { LocalAttachmentStorage } from "../../src/modules/tasks/adapters/outbound/file-attachment-storage.js";
import { Hub } from "../../src/platform/events/hub.js";
import { InProcessBackend } from "../../src/modules/agents/adapters/outbound/inproc-backend.js";
import { LocalNativeSessionAdapter } from "../../src/modules/tasks/adapters/outbound/native-session-adapter.js";
import { LocalRepositoryPaths } from "../../src/modules/spaces/adapters/outbound/repository-paths.js";
import { NodeIdentifierGenerator } from "../../src/platform/process/id-generator.js";
import { ProcessSupervisor } from "../../src/modules/agents/adapters/outbound/supervisor.js";
import { WorktreeManager } from "../../src/modules/spaces/adapters/outbound/worktree.js";

async function eventually(check: () => boolean) {
  for (let n = 0; n < 100; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.ok(check(), "condition did not settle");
}
async function setup(t: test.TestContext, preview = false) {
  const dir = mkdtempSync(join(tmpdir(), "palmagent-shared-test-"));
  const home = join(dir, "provider"), cwd = join(dir, "workspace"), sessionId = "00000000-0000-4000-8000-000000000001";
  mkdirSync(cwd);
  const transcript = join(home, "sessions/2026/01/01", `rollout-fixture-${sessionId}.jsonl`);
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd } }) + "\n");
  const db = new Db(join(dir, "palmagent.db"));
  const native = new LocalNativeSessionAdapter(db.path);
  native.home = () => home;
  native.sharedSocket = () => join(dir, "native.sock");
  const writer = spawn(process.execPath, ["-e", "process.title = 'codex'; setInterval(() => {}, 1000); process.send('ready')"],
    { argv0: "codex", stdio: ["ignore", "ignore", "ignore", "ipc"] });
  // spawn fires before Node finishes initializing its /proc command line.
  await once(writer, "message");
  const snapshot: SharedSessionSnapshot = { historyMode: "legacy", status: "running", turnId: "native-turn", model: "fixture" };
  const sent: string[] = [], decisions: string[] = [];
  let unavailable = false, ack: "delivered" | "unknown" | "rejected" = "delivered", interruptCount = 0, opens = 0;
  const events: SharedSessionEvent[] = [];
  let taskId = "";
  const event = (key: string, kind: "assistant_text" | "result" | "tool_result", payload: any) => events.push({ key, event: { taskId, sessionId, kind, payload } });
  const services: ReturnType<typeof createTaskService>[] = [];
  const make = async () => {
    const backend = new InProcessBackend();
    backend.agentRunner = () => { throw new Error("A shared session must not start a second writer"); };
    const service = createTaskService(db, new Hub(), new ProcessSupervisor(1), backend, new WorktreeManager(), new LocalAttachmentStorage(db), new LocalRepositoryPaths(), native, new NodeIdentifierGenerator());
    service.sharedSessions = { connect: async request => {
      opens++; taskId = request.taskId;
      const connection: SharedSessionConnection = {
        snapshot: async () => { if (unavailable) throw new Error("connection lost"); return { ...snapshot }; },
        history: async () => [...events],
        send: async text => { sent.push(text); snapshot.status = "running"; return ack; },
        interrupt: async () => { interruptCount++; snapshot.status = "idle"; event("stopped", "result", { is_error: true, subtype: "interrupted" }); return true; },
        approve: async (_id, decision) => { decisions.push(decision); delete snapshot.approval; return true; },
        answer: async () => { delete snapshot.question; return true; },
        close() {},
      };
      return connection;
    } };
    services.push(service); await service.init(); return service;
  };
  t.after(async () => {
    for (const service of services) service.beginShutdown();
    writer.kill(); await once(writer, "close"); db.close(); rmSync(dir, { recursive: true, force: true });
  });
  const service = await make();
  const connector = service.sharedSessions;
  if (preview) service.sharedSessions = undefined;
  const task = await service.dispatchSession({ agent: "codex", sessionId, cwd, home, waitPid: writer.pid! });
  const enableConnection = () => { service.sharedSessions = connector; };
  const refresh = async (target = service) => { target.reconcileLocalSessions(); await new Promise(resolve => setTimeout(resolve, 20)); };
  return { service, task, writer, db, snapshot, sent, decisions, event, make, refresh, enableConnection, setUnavailable: (value: boolean) => { unavailable = value; }, setAck: (value: typeof ack) => { ack = value; }, clearEvents: () => { events.length = 0; }, get opens() { return opens; }, get interruptCount() { return interruptCount; } };
}

test("shared tool input_image output is visible and deduplicated across reconnects", { skip: process.platform !== "linux" }, async t => {
  const f = await setup(t), id = f.task.taskId;
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=";
  f.event("image-tool", "tool_result", { tool_use_id: "preview", content: [{ type: "input_image", image_url: `data:image/png;base64,${png}` }] });
  await f.refresh();
  const rows = () => f.db.eventsAfterSeq(id, 0).filter(row => ["tool_result", "output_image"].includes(row.event.kind));
  assert.deepEqual(rows().map(row => row.event.kind), ["tool_result", "output_image"]);
  assert.equal(JSON.stringify(rows()[0].event.payload).includes(png), false);
  assert.deepEqual(rows()[1].event.payload, { mediaType: "image/png", data: png, width: 1, height: 1, tool_use_id: "preview" });
  f.service.beginShutdown();
  const restarted = await f.make();
  await f.refresh(restarted);
  assert.equal(rows().length, 2);
});

test("dispatch joins the live writer; browser input, questions and stop use that connection", { skip: process.platform !== "linux" }, async t => {
  const f = await setup(t), id = f.task.taskId;
  assert.equal(f.task.sessionControl?.owner, "shared");
  assert.equal(f.task.status, "running");
  assert.equal(f.writer.exitCode, null);
  f.service.submitMessage(id, { clientMessageId: "message-1", text: "Continue from my phone", mode: "send", expectedRunId: f.service.messages.state(id).runId });
  await eventually(() => f.service.messages.state(id).messages[0]?.status === "delivered");
  assert.deepEqual(f.sent, ["Continue from my phone"]);
  f.snapshot.question = { requestId: "question-1", questions: [{ id: "choice", question: "Choose", options: [] }] };
  await f.refresh(); assert.equal(f.task.status, "awaiting_input");
  await f.service.answer(id, { requestId: "question-1", answers: [{ questionId: "choice", question: "Choose", selected: ["yes"] }] });
  assert.equal(f.task.pendingInput, undefined);
  f.snapshot.approval = { requestId: "approval-1", tool: "bash" };
  await f.refresh(); await f.service.approve(id, "deny");
  assert.deepEqual(f.decisions, ["deny"]);
  await f.service.stop(id);
  assert.equal(f.interruptCount, 1); assert.equal(f.writer.exitCode, null);
  assert.equal(f.task.status, "idle"); assert.equal(f.task.interrupted, true);
  assert.equal(f.task.sessionControl?.owner, "shared");
  assert.match(f.service.handoff(id).command, /'--remote' 'unix:\/\/.*native.sock'/);
});

test("reconnect deduplicates history and never replays an unconfirmed message", { skip: process.platform !== "linux" }, async t => {
  const f = await setup(t), id = f.task.taskId;
  f.event("item-1", "assistant_text", { text: "Saved response", messageId: "item-1" });
  await f.refresh(); await f.refresh();
  assert.equal(f.db.eventsAfterSeq(id, 0).filter(row => row.event.kind === "assistant_text").length, 1);
  f.setAck("unknown");
  f.service.submitMessage(id, { clientMessageId: "message-2", text: "Only once", mode: "send", expectedRunId: f.service.messages.state(id).runId });
  await eventually(() => f.service.messages.state(id).messages[0]?.status === "unknown");
  f.service.beginShutdown();
  const restarted = await f.make();
  await eventually(() => restarted.getTask(id).sessionControl?.connection === "connected");
  await f.refresh(restarted);
  assert.equal(f.db.eventsAfterSeq(id, 0).filter(row => row.event.kind === "assistant_text").length, 1);
  assert.deepEqual(f.sent, ["Only once"]);
  assert.equal(restarted.messages.state(id).paused, true);
  assert.equal(restarted.getTask(id).sessionControl?.owner, "shared");
  assert.equal(f.writer.exitCode, null);
});

test("connection loss fails closed and queued input waits for the existing turn", { skip: process.platform !== "linux" }, async t => {
  const f = await setup(t), id = f.task.taskId;
  f.service.submitMessage(id, { clientMessageId: "message-3", text: "Next turn", mode: "queue", expectedRunId: f.service.messages.state(id).runId });
  assert.equal(f.sent.length, 0);
  f.snapshot.status = "idle"; f.event("turn-completed", "result", { is_error: false, subtype: "completed" });
  await f.refresh(); await eventually(() => f.sent.length === 1);
  f.setUnavailable(true); await f.refresh();
  assert.equal(f.task.sessionControl?.owner, "shared");
  assert.equal(f.task.sessionControl?.connection, "reconnecting");
  assert.throws(() => f.service.followup(id, "Must not start another process"), /reconnecting/);
  assert.equal(f.writer.exitCode, null);
});

test("a failed latest turn does not drain the queue after an earlier success", { skip: process.platform !== "linux" }, async t => {
  const f = await setup(t), id = f.task.taskId;
  f.event("old-success", "result", { is_error: false });
  f.service.submitMessage(id, { clientMessageId: "message-4", text: "Wait for success", mode: "queue", expectedRunId: f.service.messages.state(id).runId });
  f.event("latest-failure", "result", { is_error: true });
  f.snapshot.status = "idle";
  await f.refresh();
  assert.equal(f.service.messages.state(id).paused, true);
  assert.deepEqual(f.sent, []);
});

test("an explicit rejection is retained without claiming an unknown delivery", { skip: process.platform !== "linux" }, async t => {
  const f = await setup(t), id = f.task.taskId;
  f.snapshot.status = "idle"; f.event("first-completed", "result", { is_error: false });
  await f.refresh(); f.setAck("rejected");
  f.service.submitMessage(id, { clientMessageId: "message-5", text: "Rejected input", mode: "send", expectedRunId: null });
  await eventually(() => f.service.messages.state(id).messages[0]?.status === "rejected");
  assert.equal(f.service.messages.state(id).paused, true);
});

test("completion received before the idle snapshot still releases the waiting queue", { skip: process.platform !== "linux" }, async t => {
  const f = await setup(t), id = f.task.taskId;
  f.service.submitMessage(id, { clientMessageId: "message-6", text: "After the current turn", mode: "queue", expectedRunId: f.service.messages.state(id).runId });
  f.event("racing-completion", "result", { turnId: "native-turn", is_error: false });
  await f.refresh(); // The provider has emitted completion but its status read was still active.
  f.clearEvents();
  f.snapshot.status = "idle";
  await f.refresh();
  await eventually(() => f.sent.length === 1);
  assert.equal(f.service.messages.state(id).paused, false);
});

test("a result for an older native turn cannot finish the newly active turn", { skip: process.platform !== "linux" }, async t => {
  const f = await setup(t), id = f.task.taskId;
  f.event("older-result", "result", { turnId: "native-turn", is_error: false });
  f.snapshot.turnId = "new-native-turn";
  await f.refresh();
  f.service.submitMessage(id, { clientMessageId: "message-7", text: "Wait for the new turn", mode: "queue", expectedRunId: f.service.messages.state(id).runId });
  f.snapshot.status = "idle";
  await f.refresh();
  assert.deepEqual(f.sent, []);
  f.event("new-result", "result", { turnId: "new-native-turn", is_error: false });
  await f.refresh(); await eventually(() => f.sent.length === 1);
});


test("an already dispatched preview connects automatically without ending its local writer", { skip: process.platform !== "linux" }, async t => {
  const f = await setup(t, true);
  assert.equal(f.task.sessionControl?.owner, "returning");
  await f.refresh(); // the old preview has imported its saved transcript
  assert.ok(f.task.sessionControl!.cursor > 0);
  f.snapshot.historyMode = "paginated";
  f.enableConnection();
  await f.refresh();
  assert.equal(f.task.sessionControl?.owner, "shared");
  assert.equal(f.task.sessionControl?.sharedHistory, "transcript");
  assert.equal(f.writer.exitCode, null);
  f.service.submitMessage(f.task.taskId, { clientMessageId: "preview-steer", text: "Send during the local turn", mode: "send", expectedRunId: f.service.messages.state(f.task.taskId).runId });
  await eventually(() => f.sent.length === 1);
});

test("live cumulative text imports only new suffixes across reconnect and completion", { skip: process.platform !== "linux" }, async t => {
  const f = await setup(t), id = f.task.taskId;
  f.event("stream-item", "assistant_text", { text: "Working", messageId: "stream-item" });
  await f.refresh(); f.clearEvents();
  f.event("stream-item", "assistant_text", { text: "Working on it", messageId: "stream-item" });
  await f.refresh();
  f.service.beginShutdown();
  const restarted = await f.make();
  await eventually(() => restarted.getTask(id).sessionControl?.connection === "connected");
  f.event("stream-item", "assistant_text", { text: "Working on it now", messageId: "stream-item" });
  await f.refresh(restarted);
  const texts = f.db.eventsAfterSeq(id, 0).filter(row => row.event.kind === "assistant_text");
  assert.deepEqual(texts.map(row => (row.event.payload as { text: string }).text), ["Working", " on it", " now"]);
});
