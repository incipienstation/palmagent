import assert from "node:assert/strict";
import test from "node:test";
import type { SkillSelection, TaskState } from "@palmagent/shared";
import { TaskExecution } from "../../../src/modules/tasks/application/use-cases/task-execution.js";
import { MessageController } from "../../../src/modules/tasks/application/use-cases/message-controller.js";
import { ProcessSupervisor } from "../../../src/modules/agents/adapters/outbound/supervisor.js";
import type { RawEvent, RunHandle, RunnerBackend, StartArgs } from "../../../src/modules/agents/api.js";
import type { MessageState } from "../../../src/modules/tasks/domain/models.js";
import { turnFailed, type TurnEvidence } from "../../../src/modules/tasks/domain/turn-policy.js";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const skill: SkillSelection = { id: "skill", name: "Review", source: "fixture" };

function fixture(t: test.TestContext, independent = false, capacity = 2) {
  const task: TaskState = { taskId: "task", repoId: "repo", agent: "codex", permission: "read-only", prompt: "initial", status: "idle",
    interrupted: false, worktreePath: "/fixture/repo", createdAt: 1, updatedAt: 1, lastActivityAt: 1 };
  let saved: MessageState | undefined, rawSeq = 7, ids = 0;
  const messages = new MessageController({
    isOpen: true, messageTaskIds: () => [task.taskId],
    readMessageState: () => saved && structuredClone(saved),
    writeMessageState: (_id, state) => { saved = structuredClone(state); },
  }, {
    assertWritable() {}, canStart: () => false, settings: () => ({}), changed() {}, start() {}, steer: async () => "delivered",
  }, { start() {}, close() {}, prune() {}, save: () => undefined, load: () => undefined, read: () => { throw new Error("unused"); } },
  { next: () => "unused", uuid: () => `run-${++ids}`, digest: value => value }, { now: () => 100, every: () => () => {} });
  const supervisor = new ProcessSupervisor(capacity);
  const starts: { args: StartArgs; emit: (event: RawEvent, seq?: number) => void; done: ReturnType<typeof deferred<void>>; handle: RunHandle; cancelled: number }[] = [];
  const released: string[] = [], events: RawEvent[] = [], errors: string[] = [], mismatches: string[] = [];
  const finished: TurnEvidence[] = [];
  const behavior: { failStart?: boolean; onStart?: (emit: (event: RawEvent, seq?: number) => void) => void } = {};
  const backend: RunnerBackend = {
    independent, listLive: async () => [], release: id => { released.push(id); },
    agentRunner: agent => ({ agent, start(args, emit) {
      assert.equal(messages.state(task.taskId).runtimeStarted, args.reattach ? undefined : true);
      if (behavior.failStart) throw new Error("spawn failed");
      const done = deferred<void>();
      const entry = { args, emit, done, cancelled: 0, handle: {} as RunHandle };
      entry.handle = { done: done.promise, steer: () => false, interrupt: () => false, approve: () => false,
        answer: () => false, cancel: () => { entry.cancelled++; } };
      starts.push(entry);
      behavior.onStart?.(emit);
      return entry.handle;
    } }),
  };
  const effects: ConstructorParameters<typeof TaskExecution>[4] = {
    transition: (task, status, opts) => { Object.assign(task, { status }, opts); },
    resolveSkills: async (_id, skills) => skills,
    error: (_task, message) => { errors.push(message); },
    sessionMismatch: id => { mismatches.push(id); },
    event: (_task, event, _seq, replayed) => {
      if (event.sessionId) task.sessionId = event.sessionId;
      if (!replayed) events.push(event);
    },
    finished: (_task, evidence) => {
      assert.equal(supervisor.has(task.taskId), false, "release the handle before task and queue completion");
      assert.equal(released.at(-1), task.taskId, "consume the backend before task and queue completion");
      finished.push(evidence);
      const failed = turnFailed(evidence, false, false);
      task.status = failed ? "failed" : "idle";
      messages.finish(task.taskId, failed, false);
    },
  };
  const execution = new TaskExecution({ getTaskRawSeq: () => rawSeq, setTaskRawSeq: (_id, seq) => { rawSeq = seq; } },
    supervisor, backend, messages, effects);
  t.after(() => { execution.close(); messages.close(); });
  const event = (kind: RawEvent["kind"], payload: unknown): RawEvent => ({ taskId: task.taskId, kind, payload } as RawEvent);
  return { task, execution, messages, supervisor, starts, released, events, errors, mismatches, finished, behavior, effects, event,
    rawSeq: () => rawSeq };
}

test("fresh execution persists admission before provider start and releases ownership before completion effects", async t => {
  const f = fixture(t);
  await f.execution.run(f.task, "prompt");
  assert.equal(f.rawSeq(), 0);
  assert.equal(f.supervisor.inUse, 1);
  assert.equal(f.task.status, "running");
  const run = f.starts[0];
  run.emit(f.event("result", { is_error: false }), 1);
  run.done.resolve(); await flush();
  assert.equal(f.finished.length, 1);
  assert.equal(f.supervisor.inUse, 0);
  assert.equal(f.messages.state("task").runId, null);
  run.done.resolve(); await flush();
  assert.equal(f.finished.length, 1);
});

for (const fail of [false, true]) test(`a superseded skill reservation cannot release or fail the newer handle (reject=${fail})`, async t => {
  const f = fixture(t), skills = deferred<SkillSelection[]>();
  f.effects.resolveSkills = () => skills.promise;
  const old = f.execution.run(f.task, "old", undefined, undefined, undefined, [skill]);
  assert.equal(f.task.status, "queued");
  f.messages.stopWaiting("task"); f.task.status = "idle";
  await f.execution.run(f.task, "new");
  const current = f.starts[0].handle, runId = f.messages.state("task").runId;
  assert.equal(f.supervisor.inUse, 2);
  if (fail) skills.reject(new Error("late failure")); else skills.resolve([skill]);
  await old;
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].args.prompt, "new");
  assert.equal(f.supervisor.get("task"), current);
  assert.equal(f.supervisor.inUse, 1);
  assert.equal(f.messages.state("task").runId, runId);
  assert.equal(f.task.status, "running");
  assert.deepEqual(f.errors, []);
});

test("Stop while waiting for capacity cannot launch the old prompt or consume the next reservation", async t => {
  const f = fixture(t, false, 1);
  assert.equal(f.supervisor.tryAcquire(), true);
  const old = f.execution.run(f.task, "stopped");
  f.messages.stopWaiting("task"); f.task.status = "idle";
  const next = f.execution.run(f.task, "next");
  f.supervisor.releaseSlot();
  await Promise.all([old, next]);
  assert.deepEqual(f.starts.map(start => start.args.prompt), ["next"]);
  assert.equal(f.supervisor.inUse, 1);
});

test("shutdown releases a waiting reservation without starting or settling the durable run", async t => {
  const f = fixture(t, false, 1);
  f.supervisor.tryAcquire();
  const waiting = f.execution.run(f.task, "pending");
  const state = f.messages.state("task");
  f.execution.close(); f.supervisor.releaseSlot(); await waiting;
  assert.equal(f.supervisor.inUse, 0);
  assert.equal(f.starts.length, 0);
  assert.deepEqual(f.messages.state("task"), state);
  assert.deepEqual(f.finished, []);
});

test("a start failure releases its reservation and records queue failure", async t => {
  const f = fixture(t);
  f.behavior.failStart = true;
  await f.execution.run(f.task, "prompt");
  assert.equal(f.supervisor.inUse, 0);
  assert.equal(f.task.status, "failed");
  assert.equal(f.messages.state("task").runId, null);
  assert.match(f.errors[0], /failed to start turn/);
  assert.deepEqual(f.released, []);
});

test("reattachment replays terminal evidence without repeating history effects or sending a prompt", async t => {
  const f = fixture(t);
  f.task.status = "awaiting_input"; f.task.sessionId = "session";
  f.task.pendingInput = { requestId: "question", questions: [] };
  f.behavior.onStart = emit => {
    emit(f.event("error", { message: "transient" }), 1);
    emit(f.event("result", { is_error: false }), 7);
  };
  f.execution.reattach(f.task);
  const run = f.starts[0];
  assert.equal(run.args.prompt, "");
  assert.equal(run.args.reattach, true);
  assert.equal(run.args.resumeFromSeq, 7);
  assert.deepEqual(run.args.pendingInput, f.task.pendingInput);
  assert.equal(f.rawSeq(), 7);
  assert.deepEqual(f.events, []);
  run.emit(f.event("status", { subtype: "process_exit", code: 0 }), 8);
  run.done.resolve(); await flush();
  assert.equal(f.events.length, 1);
  assert.equal(f.finished[0].sawResult, true);
  assert.equal(f.task.status, "idle");
});

test("late output from a completed turn cannot alter or cancel its successor", async t => {
  const f = fixture(t);
  await f.execution.run(f.task, "first");
  const first = f.starts[0];
  first.done.resolve(); await flush();
  await f.execution.run(f.task, "next");
  const next = f.starts[1];
  f.task.sessionId = "session";
  first.emit({ ...f.event("error", { message: "late" }), sessionId: "wrong-session" }, 1);
  await flush();
  assert.equal(next.cancelled, 0);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.mismatches, []);
  assert.equal(f.supervisor.get("task"), next.handle);
  next.done.resolve(); await flush();
  assert.equal(f.task.status, "idle");
  assert.equal(f.finished.length, 2);
});

test("synchronous session mismatch cancels only its own handle and preserves the original session", async t => {
  const f = fixture(t);
  f.task.sessionId = "session";
  f.behavior.onStart = emit => emit({ ...f.event("status", { subtype: "init" }), sessionId: "wrong-session" });
  await f.execution.run(f.task, "prompt"); await flush();
  const run = f.starts[0];
  assert.equal(run.cancelled, 1);
  assert.equal(f.task.sessionId, "session");
  run.emit(f.event("result", { is_error: false }));
  run.done.resolve(); await flush();
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].kind, "error");
  assert.equal(f.task.status, "failed");
});

test("view shutdown ignores completion and output without releasing a retained execution", async t => {
  const f = fixture(t, true);
  f.supervisor.tryAcquire = () => { throw new Error("independent admission is owned by the backend"); };
  await f.execution.run(f.task, "prompt");
  const run = f.starts[0], state = f.messages.state("task");
  f.execution.close();
  f.execution.reattach(f.task);
  await f.execution.run(f.task, "after shutdown");
  assert.equal(f.starts.length, 1);
  run.emit(f.event("result", { is_error: false }));
  run.done.resolve(); await flush();
  assert.equal(run.cancelled, 0);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.finished, []);
  assert.deepEqual(f.released, []);
  assert.deepEqual(f.messages.state("task"), state);
});
