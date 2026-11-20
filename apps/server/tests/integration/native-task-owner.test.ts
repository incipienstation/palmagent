import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Db } from "../../src/composition/database.js";
import { createAttachmentStorage } from "../../src/composition/attachments.js";
import { MessageController } from "../../src/modules/tasks/application/use-cases/message-controller.js";
import { NativeRetainedTurns } from "../../src/modules/tasks/adapters/outbound/native-retained-turns.js";
import { acquireRuntimeLock } from "../../src/platform/filesystem/update-lock.js";
import { NodeIdentifierGenerator } from "../../src/platform/process/id-generator.js";

test("native queue commits before dispatch, rolls back with completion and preserves uncertain delivery across owner replacement", async t => {
  const root = mkdtempSync(join(tmpdir(), "palmagent-task-owner-"));
  const path = join(root, "database.sqlite"), binary = fileURLToPath(new URL("../../../../target/debug/palmagent-runtime", import.meta.url));
  const lease = acquireRuntimeLock(root);
  const db = new Db(path);
  const ids = new NodeIdentifierGenerator();
  let native = new NativeRetainedTurns(binary, path, lease.fd);
  t.after(async () => { await native.close(); db.close(); lease(); rmSync(root, { recursive: true, force: true }); });
  db.insertRepo({ id: "space", name: "Fixture", path: root, vcs: "none", defaultBaseRef: "", createdAt: 1 });
  assert.deepEqual(native.recover([], () => assert.fail("unexpected attachment"), 1), { reattached: [], recovered: [] });
  const task = { taskId: "task", repoId: "space", agent: "codex", prompt: "Initial", status: "idle",
    permission: "read-only", interrupted: false, createdAt: 1, updatedAt: 1, lastActivityAt: 1 } as const;
  const file = { id: ids.uuid(), taskId: "task", mediaType: "image/png", size: 8, digest: "fixture" };
  const stage = () => native.attachments.transaction(() => native.attachments.insertAttachment(file));
  assert.throws(() => native.create(task, () => { stage(); throw new Error("staging failed"); }), /staging failed/);
  assert.equal(db.getTask("task"), undefined);
  assert.equal(db.attachment("task", file.id), undefined);
  native.create(task, stage);
  assert.deepEqual(native.attachments.attachmentByDigest("task", file.digest), db.attachment("task", file.id));
  db.selectEventWriter(native);
  const events = [{ taskId: "task", agent: "codex" as const, kind: "assistant_text" as const, payload: { text: "stream" }, ts: 2 }];
  assert.equal(db.appendAgentEvents("task", events, 1)[0].seq, 1);
  assert.equal(db.conversationPage("task").cursor, 1);
  assert.equal(db.getTaskRawSeq("task"), 1);
  assert.throws(() => native.append("task", events, 2, () => { throw new Error("projection refused"); }), /projection refused/);
  assert.equal(db.conversationPage("task").cursor, 1);
  assert.equal(db.getTaskRawSeq("task"), 1);
  assert.equal(db.eventCursor("task"), 1);
  const attachments = createAttachmentStorage(native.attachments);
  let starts = 0, runId: string;
  const controller = new MessageController(db, {
    assertWritable() {}, canStart: () => true, settings: () => ({}), changed() {},
    start(id, message) {
      starts++;
      assert.equal(db.readMessageState(id)?.messages[0].status, "sending");
      runId = controller.beginRun(id, message.id, undefined, true);
      native.start(id, runId, 5);
    },
    steer: async () => "delivered",
  }, attachments, ids, { now: () => 1, every: () => () => {} }, native);
  t.after(() => controller.close());
  const req = { clientMessageId: ids.uuid(), mode: "send" as const, text: 'Unicode 🌱, \ud800, \ue000 and "quotes"', expectedRunId: null };
  const first = controller.submit("task", req);
  assert.deepEqual(controller.submit("task", req), first);
  assert.equal(db.readMessageState("task")?.messages[0].text, req.text);
  assert.equal(starts, 1);
  native.metadata.setTaskTitle("task", "Current", 6);
  assert.throws(() => native.metadata.transaction(() => {
    native.metadata.setTaskTitle("task", "Partial", 7);
    native.metadata.setTaskStatus("missing", "idle", false, 7);
  }), /Task disappeared/);
  assert.equal(db.getTask("task")?.title, "Current");
  assert.equal(db.getTask("task")?.status, "running");
  assert.equal(db.readMessageState("task")?.executionId, runId!);
  assert.equal(db.readMessageState("task")?.runtimeStarted, true);
  assert(!("fingerprint" in first.messages[0]));
  assert.throws(() => db.transaction(() => {
    controller.finish("task", false, false);
    assert.equal(db.readMessageState("task")?.runId, null);
    throw new Error("event projection failed");
  }), /event projection failed/);
  assert.equal(db.readMessageState("task")?.runId, runId!);
  await native.close();
  native = new NativeRetainedTurns(binary, path, lease.fd);
  assert.throws(() => native.recover([], () => assert.fail(), 8), /no execution identity/);
  assert.equal(db.readMessageState("task")?.messages[0].status, "sending");
  const attached: string[] = [];
  assert.deepEqual(native.recover(["task"], id => attached.push(id), 9), { reattached: ["task"], recovered: [] });
  assert.deepEqual(attached, ["task"]);
  assert.equal(db.readMessageState("task")?.messages[0].status, "unknown");
  assert.equal(db.readMessageState("task")?.paused, true);
});
