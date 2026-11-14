import assert from "node:assert/strict";
import test from "node:test";
import { MessageController } from "../../../src/modules/tasks/application/use-cases/message-controller.js";
import type { MessageState } from "../../../src/modules/tasks/domain/models.js";
import type { MessageStateRepository } from "../../../src/modules/tasks/application/ports/outbound/persistence.js";
import type { AttachmentStorage } from "../../../src/modules/tasks/application/ports/outbound/attachments.js";

function fixture(t: test.TestContext) {
  let persisted: MessageState | undefined;
  let now = 1000, tick = () => {}, cancellations = 0, nextId = 0, failWrite = false;
  const repo: MessageStateRepository = {
    isOpen: true, messageTaskIds: () => ["task"],
    readMessageState: () => persisted && structuredClone(persisted),
    writeMessageState: (_id, state) => {
      if (failWrite) throw new Error("write failed");
      persisted = structuredClone(state);
    },
  };
  const starts: string[] = [], steers: string[] = [];
  const host = {
    assertWritable() {}, canStart: () => false, settings: () => ({}), changed() {},
    start(_id: string, message: { id: string }) {
      assert.equal(persisted?.messages.find(m => m.id === message.id)?.status, "sending");
      starts.push(message.id);
    },
    async steer(_id: string, message: { id: string }): Promise<"delivered" | "unknown" | "rejected"> {
      assert.equal(persisted?.messages.find(m => m.id === message.id)?.status, "sending");
      steers.push(message.id);
      return "delivered";
    },
  };
  const attachments: AttachmentStorage = {
    start() {}, close() {}, prune() {}, save: () => undefined, load: () => undefined,
    read: () => { throw new Error("unused"); },
  };
  const controller = new MessageController(repo, host, attachments, {
    next: prefix => `${prefix}-${++nextId}`, uuid: () => `run-${++nextId}`, digest: value => value,
  }, {
    now: () => now,
    every(ms, callback) {
      assert.equal(ms, 1000);
      tick = callback;
      return () => { cancellations++; };
    },
  });
  t.after(() => controller.close());
  return { controller, repo, host, attachments, starts, steers,
    tick: () => tick(), time: (value: number) => { now = value; },
    cancellations: () => cancellations, failWrites: () => { failWrite = true; },
    submit: (id: string) => controller.submit("task", { clientMessageId: id, mode: "queue", text: id, expectedRunId: null }),
  };
}

test("the injected polling clock releases expired edits without bypassing FIFO or claiming twice", t => {
  const f = fixture(t);
  f.submit("first"); f.submit("second");
  f.controller.action("task", "first", { action: "edit", token: "editor", version: 1 });
  f.host.canStart = () => true;
  f.time(60999); f.tick(); assert.deepEqual(f.starts, []);
  f.time(61000); f.tick(); assert.deepEqual(f.starts, ["first"]);
  f.tick(); assert.deepEqual(f.starts, ["first"]);
  f.controller.close(); f.controller.close();
  f.tick(); assert.equal(f.cancellations(), 1);
});

test("database shutdown cancels polling before reading queue state", t => {
  const f = fixture(t);
  Object.defineProperty(f.repo, "isOpen", { value: false });
  f.repo.messageTaskIds = () => { throw new Error("closed database read"); };
  f.tick(); f.tick();
  assert.equal(f.cancellations(), 1);
});

test("a failed claim write cannot reach the execution host", t => {
  const f = fixture(t);
  f.submit("first");
  f.host.canStart = () => true;
  f.failWrites();
  assert.throws(() => f.controller.pump("task"), /write failed/);
  assert.deepEqual(f.starts, []);
  assert.equal(f.controller.state("task").messages[0].status, "queued");
});

test("late rejected provider receipts re-read state and cannot undo confirmed delivery", async t => {
  const f = fixture(t);
  let reject!: (reason: Error) => void;
  f.host.steer = () => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; });
  const runId = f.controller.beginRun("task");
  f.controller.submit("task", { clientMessageId: "send", mode: "send", text: "once", expectedRunId: runId });
  f.controller.delivered("task", "send");
  const confirmed = f.controller.state("task");
  reject(new Error("late transport failure"));
  await Promise.resolve();
  assert.deepEqual(f.controller.state("task"), confirmed);
});

test("shutdown ignores pending provider receipts and preserves durable uncertainty", async t => {
  const f = fixture(t);
  let resolve!: (status: "delivered") => void;
  f.host.steer = () => new Promise(resolvePromise => { resolve = resolvePromise; });
  const runId = f.controller.beginRun("task");
  f.controller.submit("task", { clientMessageId: "send", mode: "send", text: "once", expectedRunId: runId });
  const sending = f.controller.state("task");
  f.controller.close(); resolve("delivered");
  await Promise.resolve();
  assert.deepEqual(f.controller.state("task"), sending);
});

test("invalid edit versions cause no attachment writes", t => {
  const f = fixture(t);
  f.submit("edit");
  f.controller.action("task", "edit", { action: "edit", token: "editor", version: 1 });
  f.attachments.save = () => { throw new Error("unexpected attachment write"); };
  assert.throws(() => f.controller.action("task", "edit", { action: "save", token: "editor", version: 0, text: "stale" }), /changed/);
  assert.equal(f.controller.state("task").messages[0].version, 1);
});
