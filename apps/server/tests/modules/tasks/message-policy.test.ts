import assert from "node:assert/strict";
import test from "node:test";
import { MessageConflict, MessagePolicy } from "../../../src/modules/tasks/domain/message-policy.js";
import type { MessageState, StoredMessage } from "../../../src/modules/tasks/domain/models.js";

function message(id: string, status: StoredMessage["status"] = "queued"): StoredMessage {
  return { id, status, version: 1, mode: "queue", text: id, fingerprint: `fingerprint-${id}` };
}
function policy(messages: StoredMessage[] = []) {
  return new MessagePolicy({ revision: 7, paused: false, runId: null, messages });
}

test("FIFO holds the first message until its edit lease expires, including at the exact boundary", () => {
  const p = policy([message("first"), message("second")]);
  const edit = { action: "edit", token: "editor", version: 1 } as const;
  const first = p.checkAction("first", edit, 1000);
  p.applyAction(first, edit, 1000);
  assert.equal(p.claimNext(true, 60999), undefined);
  assert.equal(p.claimNext(false, 61000), undefined);
  assert.throws(() => p.checkAction("first", { action: "save", token: "editor", version: 1, text: "late" }, 61000), /expired/);
  assert.equal(p.claimNext(true, 61000)?.id, "first");
  assert.equal(p.claimNext(true, 61000), undefined, "a sending message blocks the next claim");
  assert.equal(p.state.revision, 7, "policy leaves persistence revisions to its caller");
});

test("edit ownership, versions, renewal and cancellation preserve queue order", () => {
  const p = policy([message("first"), message("second")]);
  const edit = { action: "edit", token: "editor", version: 1 } as const;
  const first = p.checkAction("first", edit, 1000);
  p.applyAction(first, edit, 1000);
  assert.throws(() => p.checkAction("first", { ...edit, token: "other" }, 2000), /another device/);
  assert.throws(() => p.checkAction("first", { action: "delete", version: 1 }, 2000), /being edited/);
  assert.throws(() => p.checkAction("first", { action: "send", version: 1, expectedRunId: null }, 2000), /Finish editing/);
  const renew = { action: "renew", token: "editor" } as const;
  p.applyAction(p.checkAction("first", renew, 60000), renew, 60000);
  assert.equal(p.claimNext(true, 61000), undefined);
  const save = { action: "save", token: "editor", version: 1, text: "edited" } as const;
  p.applyAction(p.checkAction("first", save, 61000), save, 61000);
  assert.equal(first.version, 2);
  assert.equal(first.text, "edited");
  assert.equal(first.editToken, undefined);
  assert.throws(() => p.checkAction("first", { action: "delete", version: 1 }, 61000), /changed/);
  const remove = { action: "delete", version: 2 } as const;
  p.applyAction(p.checkAction("first", remove, 61000), remove, 61000);
  assert.equal(p.claimNext(true, 61000)?.id, "second");
});

for (const live of [false, true]) for (const runtimeStarted of [false, true]) {
  test(`recovery uses live=${live} and runtimeStarted=${runtimeStarted} without guessing delivery`, () => {
    const first = { ...message("initial", "sending"), runId: "run" };
    const followup = { ...message("followup", "sending"), runId: "run" };
    const state: MessageState = { revision: 1, paused: false, runId: "run", initialMessageId: "initial", runtimeStarted,
      messages: [first, followup, message("next")], compaction: { requestId: "compact", status: "running" } };
    const p = new MessagePolicy(state);
    p.recover(live);
    assert.equal(first.status, !live && !runtimeStarted ? "queued" : "unknown");
    assert.equal(followup.status, "unknown", "only the initial message can be known not to have started");
    assert.equal(state.runId, live ? "run" : null);
    assert.equal(state.paused, true);
    assert.equal(state.compaction?.status, live ? "running" : "failed");
    assert.equal(p.claimNext(true, 1000), undefined);
    assert.throws(() => p.resume(), /unconfirmed/);
  });
}

test("finish retains uncertain delivery and late confirmation wins over later failure receipts", () => {
  const p = policy([message("sent", "sending"), message("next")]);
  p.beginRun("run", "sent"); p.startingRuntime(); p.finish(false);
  assert.equal(p.state.messages[0].status, "unknown");
  assert.equal(p.state.paused, true);
  assert.equal(p.delivered("sent"), true);
  assert.equal(p.settleSteer("sent", "rejected"), false);
  assert.equal(p.settleSteer("sent", "unknown", true), false);
  assert.equal(p.deliveryFailed("sent", "unknown"), false);
  assert.equal(p.state.messages[0].status, "delivered");
  assert.equal(p.claimNext(true, 0), undefined, "confirmation does not implicitly resume a paused queue");
  p.resume(); assert.equal(p.claimNext(true, 0)?.id, "next");
});

test("stopping before runtime entry restores only the initial message and keeps the queue paused", () => {
  const p = policy([message("initial", "sending"), message("next")]);
  p.beginRun("run", "initial", "compact");
  p.stopWaiting();
  assert.equal(p.state.messages[0].status, "queued");
  assert.equal(p.state.messages[0].runId, undefined);
  assert.equal(p.state.runId, null);
  assert.equal(p.state.paused, true);
  assert.equal(p.state.compaction?.status, "failed");
  assert.equal(p.claimNext(true, 0), undefined);
});

test("submission conflicts preserve identity, run targeting and explicit send semantics", () => {
  const p = policy([message("known", "delivered")]);
  assert.equal(p.hasSubmission("known", "fingerprint-known"), true);
  assert.throws(() => p.hasSubmission("known", "changed"), MessageConflict);
  const req = { clientMessageId: "new", mode: "send", text: "new", expectedRunId: null } as const;
  assert.throws(() => p.assertSubmission(req, false), /cannot start/);
  p.beginRun("run");
  assert.throws(() => p.assertSubmission(req, true), /active run changed/);
  assert.throws(() => p.assertSubmission({ ...req, expectedRunId: "run", settings: { model: "different" } }, true), /next run/);
  p.state.messages.push(message("uncertain", "unknown"));
  assert.throws(() => p.assertSubmission({ ...req, expectedRunId: "run" }, true), /confirmed/);
  p.assertSubmission({ ...req, mode: "queue" }, false);
  const snapshot = p.snapshot();
  assert.equal(snapshot.messages.length, 1);
  assert.equal("fingerprint" in snapshot.messages[0], false);
});
