import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Db } from "../src/db.js";
import { Hub } from "../src/hub.js";
import { TaskService } from "../src/service.js";
import { ProcessSupervisor } from "../src/supervisor.js";
import { WorktreeManager } from "../src/worktree.js";
import { ExecutionBackend } from "../src/execution/client.js";
import { ExecutionStore } from "../src/execution/store.js";

const question = { requestId: "q1", questions: [{ question: "Continue?", options: [{ label: "Yes" }] }] };
const answer = { requestId: "q1", answers: [{ question: "Continue?", selected: ["Yes"] }] };
async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "palmagent-input-state-"));
  const db = new Db(join(root, "tasks.sqlite"));
  const store = new ExecutionStore(join(root, "executions"));
  const now = Date.now();
  db.insertRepo({ id: "repo", name: "Fixture", path: root, vcs: "none", defaultBaseRef: "", createdAt: now });
  db.insertTask({ taskId: "task", repoId: "repo", agent: "claude", prompt: "Fixture", status: "awaiting_input",
    interrupted: false, permission: "acceptEdits", worktreePath: root, createdAt: now, updatedAt: now, lastActivityAt: now });
  db.setTaskPendingInput("task", question, now);
  const record = store.reserve({ taskId: "task", agent: "claude", cwd: root, prompt: "Fixture" }, "/opt/fixture", process.execPath);
  store.admit(1); store.claim(record.id);
  store.append(record.id, { taskId: "task", kind: "question", payload: question });
  db.setTaskRawSeq("task", 2);
  let backend: ExecutionBackend, service: TaskService;
  const start = async () => {
    backend = new ExecutionBackend(store.directory, "/opt/fixture", process.execPath, 1, () => {});
    service = new TaskService(db, new Hub(), new ProcessSupervisor(1), backend, new WorktreeManager());
    await service.init();
    return service;
  };
  const close = () => { service.beginShutdown(); backend.close(); };
  t.after(() => { close(); store.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  await start();
  const command = () => {
    const commands = store.pending(record.id);
    assert.equal(commands.length, 1);
    return commands[0];
  };
  return { db, store, record, service: service!, command, close, start };
}

test("answer rejection keeps the question and allows an explicit retry after confirmed rejection", async t => {
  const f = await fixture(t);
  const rejected = assert.rejects(f.service.answer("task", answer), /delivery could not be confirmed/);
  const first = f.command();
  assert.equal(f.service.getTask("task").status, "awaiting_input");
  assert.deepEqual(JSON.parse(f.store.get(f.record.id).question!), question);
  await assert.rejects(f.service.answer("task", answer), /delivery could not be confirmed/);
  f.store.settle(f.record.id, first.id, "rejected");
  await rejected;
  assert.deepEqual(f.service.getTask("task").pendingInput, question);
  const success = f.service.answer("task", answer);
  const second = f.command();
  f.store.settle(f.record.id, second.id, "delivered");
  assert.equal((await success).status, "running");
  assert.equal(f.service.getTask("task").pendingInput, undefined);
  assert.equal(f.store.get(f.record.id).question, null);
});

test("uncertain answer delivery preserves input and cannot be resent", async t => {
  const f = await fixture(t);
  const result = assert.rejects(f.service.answer("task", answer), /delivery could not be confirmed/);
  f.store.settle(f.record.id, f.command().id, "unknown");
  await result;
  await assert.rejects(f.service.answer("task", answer), /delivery could not be confirmed/);
  assert.deepEqual(f.service.getTask("task").pendingInput, question);
  assert.equal(f.service.getTask("task").status, "awaiting_input");
  assert.equal(f.store.pending(f.record.id).length, 0);
});

test("an answer delivered while the view is absent resumes state exactly once on recovery", async t => {
  const f = await fixture(t);
  const pending = assert.rejects(f.service.answer("task", answer), /delivery could not be confirmed/);
  const command = f.command();
  f.close();
  await pending;
  f.store.settle(f.record.id, command.id, "delivered");
  f.store.settle(f.record.id, command.id, "delivered");
  const service = await f.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.getTask("task").status, "running");
  assert.equal(service.getTask("task").pendingInput, undefined);
  const answers = f.store.events(f.record.id, 0).filter(r => (r.event.payload as { subtype?: string }).subtype === "answer");
  assert.equal(answers.length, 1);
  assert.equal(f.db.getTask("task")?.status, "running");
});

test("a late answer receipt cannot revive a cancelled task or clear a newer question", async t => {
  const f = await fixture(t);
  const pending = f.service.answer("task", answer);
  const command = f.command();
  const next = { ...question, requestId: "q2" };
  f.store.append(f.record.id, { taskId: "task", kind: "question", payload: next });
  f.service.cancel("task");
  f.store.settle(f.record.id, command.id, "delivered");
  assert.equal((await pending).status, "cancelled");
  assert.equal(f.service.getTask("task").pendingInput?.requestId, "q2");
  assert.equal(JSON.parse(f.store.get(f.record.id).question!).requestId, "q2");
});
