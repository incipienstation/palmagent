import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Db } from "../src/db.js";
import { LocalAttachmentStorage } from "../src/attachments.js";
import { MessageController } from "../src/message-controller.js";

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "message-controller-"));
  const db = new Db(join(dir, "state.db"));
  db.insertRepo({ id: "r", name: "Example", path: dir, vcs: "none", defaultBaseRef: "", createdAt: 1 });
  db.insertTask({ taskId: "t", repoId: "r", agent: "codex", prompt: "Initial", status: "running", interrupted: false, permission: "read-only", createdAt: 1, updatedAt: 1, lastActivityAt: 1 });
  let active = true, writable = true;
  const starts: string[] = [], steers: string[] = [];
  let receipt: (s: "delivered" | "unknown" | "rejected") => void = () => {};
  const host = {
    assertWritable() { if (!writable) throw Error("local owner"); },
    canStart() { return !active; }, settings() { return { model: "original" }; }, changed() {},
    start(_id: string, m: { id: string; text: string }) { active = true; starts.push(m.text); controller.beginRun("t"); controller.delivered("t", m.id); },
    steer(_id: string, m: { text: string }) { steers.push(m.text); return new Promise<"delivered" | "unknown" | "rejected">(resolve => { receipt = resolve; }); },
  };
  const attachments = new LocalAttachmentStorage(db);
  let controller = new MessageController(db, host, attachments);
  controller.beginRun("t");
  t.after(() => { controller.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get c() { return controller; }, starts, steers,
    submit(text: string, mode: "send" | "queue" = "queue", id = randomUUID()) {
      return controller.submit("t", { clientMessageId: id, text, mode, expectedRunId: controller.state("t").runId });
    },
    finish(failed = false) { active = false; controller.finish("t", failed); },
    writable(value: boolean) { writable = value; },
    receipt(value: "delivered" | "unknown" | "rejected") { receipt(value); },
    restart(live: boolean) { controller.close(); controller = new MessageController(db, host, attachments); controller.recover("t", live); },
  };
}
test("FIFO preserves individual prompts and settings through persistence", t => {
  const f = fixture(t);
  f.submit("first"); f.submit("second"); f.restart(true);
  assert.equal(f.c.snapshot("t").messages[0].settings?.model, "original");
  f.finish(); assert.deepEqual(f.starts, ["first"]);
  f.finish(); assert.deepEqual(f.starts, ["first", "second"]);
});
test("editing holds queue order; save checks version and retains position", t => {
  const f = fixture(t); f.submit("first"); f.submit("second");
  const m = f.c.snapshot("t").messages[0], token = randomUUID();
  f.c.action("t", m.id, { action: "edit", token, version: 1 });
  f.finish(); assert.deepEqual(f.starts, []);
  assert.throws(() => f.c.action("t", m.id, { action: "save", token, version: 0, text: "stale" }), /changed/);
  f.c.action("t", m.id, { action: "save", token, version: 1, text: "edited", images: [{ mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==" }] });
  assert.deepEqual(f.starts, ["edited"]); f.finish(); assert.deepEqual(f.starts, ["edited", "second"]);
});
test("Stop and failure preserve prompts and require explicit resume", t => {
  const f = fixture(t); f.submit("later"); f.c.pause("t"); f.finish();
  assert.deepEqual(f.starts, []); assert.equal(f.c.snapshot("t").messages[0].text, "later");
  f.c.resume("t"); assert.deepEqual(f.starts, ["later"]);
  f.submit("after failure"); f.finish(true); assert.equal(f.c.snapshot("t").paused, true);
});
test("Send targets a run, never silently queues, and lost acknowledgement is not retried", async t => {
  const f = fixture(t); const id = randomUUID(), expectedRunId = f.c.state("t").runId;
  const request = { clientMessageId: id, mode: "send" as const, text: "now", expectedRunId };
  f.c.submit("t", request); f.c.submit("t", request);
  assert.deepEqual(f.steers, ["now"]);
  assert.throws(() => f.c.submit("t", { ...request, text: "different" }), /different content/);
  f.restart(true); assert.equal(f.c.snapshot("t").messages[0].status, "unknown");
  assert.throws(() => f.c.resume("t"), /unconfirmed/);
  f.c.delivered("t", id); assert.equal(f.c.snapshot("t").messages.length, 0);
  assert.throws(() => f.c.submit("t", { ...request, clientMessageId: randomUUID(), expectedRunId: "old" }), /active run changed/);
});
test("ownership checks cover edit, delete, send and resume", t => {
  const f = fixture(t); f.submit("queued"); const m = f.c.snapshot("t").messages[0]; f.writable(false);
  assert.throws(() => f.submit("blocked"), /local owner/);
  assert.throws(() => f.c.action("t", m.id, { action: "delete", version: 1 }), /local owner/);
  assert.throws(() => f.c.resume("t"), /local owner/);
});

test("selected skills survive restart, idempotent submission and queue editing", t => {
  const f = fixture(t);
  const skill = { id: "skill-1", name: "palmagent:doctor", source: "palmagent", pluginId: "palmagent@palmagent" };
  const req = { clientMessageId: randomUUID(), mode: "queue" as const, text: "Check service", skills: [skill], expectedRunId: f.c.state("t").runId };
  f.c.submit("t", req); f.c.submit("t", req); f.restart(true);
  assert.deepEqual(f.c.snapshot("t").messages[0].skills, [skill]);
  assert.throws(() => f.c.submit("t", { ...req, skills: [] }), /different content/);
  const token = randomUUID();
  f.c.action("t", req.clientMessageId, { action: "edit", token, version: 1 });
  f.c.action("t", req.clientMessageId, { action: "save", token, version: 1, text: "Plain request", skills: [] });
  f.restart(true);
  assert.deepEqual(f.c.snapshot("t").messages[0].skills, []);
});

test("failed skill validation before spawn is rejected, never recorded as uncertain delivery", t => {
  const f = fixture(t);
  const id = randomUUID();
  f.c.submit("t", { clientMessageId: id, mode: "send", text: "Check", skills: [{ id: "skill", name: "check", source: "repo" }], expectedRunId: f.c.state("t").runId });
  f.c.rejectBeforeStart("t", "Skill is unavailable");
  assert.equal(f.c.snapshot("t").messages[0].status, "rejected");
  assert.equal(f.c.snapshot("t").messages[0].error, "Skill is unavailable");
  assert.equal(f.c.snapshot("t").paused, true);
});
