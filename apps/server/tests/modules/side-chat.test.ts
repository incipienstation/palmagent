import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { CodexSideChats } from "../../src/modules/agents/adapters/outbound/side-chat.js";
import { SideChatSendSchema } from "@palmagent/shared";

const target = { taskId: "task-one", sessionId: "parent-thread", home: "/provider-home", cwd: "/workspace" };
function fixture(mode = "success", leaseMs = 30_000, rpcMs = 500) {
  const requests: any[] = [], children: any[] = [];
  const sessions = new CodexSideChats(() => {
    const threadId = "side-" + children.length;
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null as string | null,
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: null as unknown as Writable,
      kill: () => { child.signalCode = "SIGTERM"; queueMicrotask(() => child.emit("exit", null, "SIGTERM")); return true; } });
    const emit = (value: unknown) => child.stdout.write(JSON.stringify(value) + "\n");
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      const msg = JSON.parse(String(chunk)); requests.push(msg); done();
      queueMicrotask(() => {
        if (!msg.id || mode === "timeout") return;
        if (msg.method === "thread/fork") {
          emit(mode === "rejected" ? { id: msg.id, error: { message: "private provider detail" } } :
            { id: msg.id, result: { thread: { id: mode === "parent" ? target.sessionId : threadId, ephemeral: mode !== "persistent" } } });
        } else if (msg.method === "turn/start") {
          if (mode === "send-timeout") return;
          emit({ method: "turn/started", params: { threadId, turn: { id: "side-turn" } } });
          emit({ id: msg.id, result: { turn: { id: "side-turn" } } });
          if (mode === "fast") emit({ method: "turn/completed", params: { threadId, turn: { id: "side-turn", status: "completed" } } });
        } else if (msg.method === "turn/interrupt") {
          emit({ id: msg.id, result: {} });
          emit({ method: "turn/completed", params: { threadId, turn: { id: "side-turn", status: "interrupted" } } });
        } else emit({ id: msg.id, result: {} });
      });
    } });
    children.push(child);
    return child as unknown as ChildProcessWithoutNullStreams;
  }, leaseMs, rpcMs);
  const event = (method: string, params: unknown, index = 0) => children[index].stdout.write(JSON.stringify({ method, params }) + "\n");
  return { sessions, requests, children, event };
}

test("side chats share one isolated ephemeral fork per task without persistent goal operations", async () => {
  const f = fixture();
  try {
    const [a, b] = await Promise.all([f.sessions.open(target), f.sessions.open(target)]);
    assert.equal(a.id, b.id); assert.equal(f.children.length, 1);
    const fork = f.requests.find(r => r.method === "thread/fork");
    assert.equal(fork.params.threadId, target.sessionId);
    assert.equal(fork.params.ephemeral, true); assert.equal(fork.params.excludeTurns, true);
    assert.equal(fork.params.deferGoalContinuation, undefined); assert.equal(fork.params.sandbox, "read-only");
    assert.equal(f.requests.some(r => r.method.startsWith("thread/goal/")), false);
    assert.equal(f.requests.some(r => r.method === "thread/resume"), false);
    assert.equal(a.status, "idle");
  } finally { f.sessions.close(); }
});

test("sending, streaming and stopping side questions never target the parent; duplicate IDs are idempotent", async () => {
  const f = fixture();
  try {
    const initial = await f.sessions.open(target);
    const message = { sessionId: initial.id, messageId: randomUUID(), text: "Explain the choice." };
    const running = await f.sessions.send(target.taskId, message);
    assert.equal(running.status, "running");
    await f.sessions.send(target.taskId, message);
    assert.equal(f.requests.filter(r => r.method === "turn/start").length, 1);
    await assert.rejects(f.sessions.send(target.taskId, { ...message, text: "Changed" }), /already been used/);
    await assert.rejects(f.sessions.send(target.taskId, { ...message, messageId: randomUUID() }), /Wait/);
    f.event("item/agentMessage/delta", { threadId: "parent-thread", itemId: "parent-answer", delta: "Do not include" });
    f.event("item/agentMessage/delta", { threadId: "side-0", itemId: "answer", delta: "Because " });
    f.event("item/agentMessage/delta", { threadId: "side-0", itemId: "answer", delta: "it fits." });
    f.event("item/completed", { threadId: "side-0", item: { type: "agentMessage", id: "answer", text: "Because it fits." } });
    const snapshot = f.sessions.get(target.taskId)!;
    assert.equal(snapshot.messages.length, 2); assert.equal(snapshot.messages[1].text, "Because it fits.");
    snapshot.messages.length = 0;
    assert.equal(f.sessions.get(target.taskId)!.messages.length, 2);
    await f.sessions.stop(target.taskId, initial.id);
    assert.equal(f.sessions.get(target.taskId)!.status, "idle");
    f.event("item/completed", { threadId: "side-0", turnId: "another-turn", item: { type: "agentMessage", id: "answer", text: "A different answer." } });
    assert.equal(f.sessions.get(target.taskId)!.messages.length, 3);
    assert.equal(f.sessions.get(target.taskId)!.messages[1].text, "Because it fits.");
    for (const request of f.requests.filter(r => /^turn\//.test(r.method))) assert.equal(request.params.threadId, "side-0");
  } finally { f.sessions.close(); }
});

test("end preserves a readable snapshot, new chats reject stale actions, and shutdown closes every process", async () => {
  const f = fixture();
  const first = await f.sessions.open(target);
  f.sessions.end(target.taskId, first.id);
  assert.equal(f.sessions.get(target.taskId)!.status, "ended");
  const second = await f.sessions.open(target);
  assert.notEqual(second.id, first.id);
  assert.throws(() => f.sessions.end(target.taskId, first.id), /ended/);
  assert.throws(() => f.sessions.end("other-task", second.id), /ended/);
  f.sessions.close();
  assert.ok(f.children.every(child => child.signalCode === "SIGTERM"));
  await assert.rejects(f.sessions.open(target), /unavailable/);
});

test("unsupported or non-isolated forks fail closed without exposing provider errors", async () => {
  for (const mode of ["rejected", "persistent", "parent"]) {
    const f = fixture(mode);
    await assert.rejects(f.sessions.open(target), error => error instanceof Error && !error.message.includes("private"));
    assert.equal(f.children[0].signalCode, "SIGTERM");
    assert.equal(f.requests.some(r => r.method === "turn/start"), false);
    f.sessions.close();
  }
});

test("uncertain sends are not replayed and fast completion is not overwritten by a start acknowledgement", async () => {
  const f = fixture("send-timeout", 1000, 20);
  try {
    const first = await f.sessions.open(target);
    const message = { sessionId: first.id, messageId: randomUUID(), text: "Question" };
    const result = await f.sessions.send(target.taskId, message);
    assert.equal(result.status, "ended"); assert.match(result.error!, /not resent/);
    await f.sessions.send(target.taskId, message);
    assert.equal(f.requests.filter(r => r.method === "turn/start").length, 1);
  } finally { f.sessions.close(); }
  const fast = fixture("fast");
  try {
    const session = await fast.sessions.open(target);
    const result = await fast.sessions.send(target.taskId, { sessionId: session.id, messageId: randomUUID(), text: "Question" });
    assert.equal(result.status, "idle"); assert.equal(result.completed, 1);
  } finally { fast.sessions.close(); }
});

test("idle expiry releases the process and malformed requests fail schema validation", async () => {
  const f = fixture("success", 20);
  try {
    await f.sessions.open(target);
    await delay(40);
    assert.equal(f.sessions.get(target.taskId)!.status, "ended");
    assert.equal(f.children[0].signalCode, "SIGTERM");
    assert.equal(SideChatSendSchema.safeParse({ sessionId: randomUUID(), messageId: randomUUID(), text: "  " }).success, false);
    assert.equal(SideChatSendSchema.safeParse({ sessionId: randomUUID(), messageId: randomUUID(), text: "x".repeat(16001) }).success, false);
  } finally { f.sessions.close(); }
});
