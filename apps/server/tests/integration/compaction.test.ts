import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TaskState } from "@palmagent/shared";
import { createTaskService } from "../../src/composition/task-service.js";
import { Db } from "../../src/composition/database.js";
import { Hub } from "../../src/platform/events/hub.js";
import { NodeIdentifierGenerator } from "../../src/platform/process/id-generator.js";
import { ProcessSupervisor } from "../../src/modules/agents/adapters/outbound/supervisor.js";
import { WorktreeManager } from "../../src/modules/spaces/adapters/outbound/worktree.js";
import { LocalRepositoryPaths } from "../../src/modules/spaces/adapters/outbound/repository-paths.js";
import { LocalAttachmentStorage } from "../../src/modules/tasks/adapters/outbound/file-attachment-storage.js";
import { LocalNativeSessionAdapter } from "../../src/modules/tasks/adapters/outbound/native-session-adapter.js";
import type { RunnerBackend } from "../../src/modules/agents/application/ports/inbound/execution.js";
import type { Emit, StartArgs } from "../../src/modules/agents/domain/execution.js";

async function fixture(t: test.TestContext, patch: Partial<TaskState> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "palmagent-compact-"));
  const db = new Db(join(dir, "state.db"));
  db.insertRepo({ id: "r", name: "Fixture", path: dir, vcs: "none", defaultBaseRef: "", createdAt: 1 });
  db.insertTask({ taskId: "t", repoId: "r", agent: "codex", prompt: "Original conversation", status: "idle", interrupted: false,
    sessionId: "session", worktreePath: dir, permission: "read-only", createdAt: 1, updatedAt: 1, lastActivityAt: 1, ...patch });
  const starts: StartArgs[] = [];
  let emit: Emit = () => {};
  let finish = () => {};
  let active = false;
  const backend: RunnerBackend = {
    listLive: async () => active ? ["t"] : [],
    agentRunner: agent => ({ agent, start(args, callback) {
      starts.push(args); emit = callback; active = true;
      return { done: new Promise<void>(resolve => { finish = () => { active = false; resolve(); }; }),
        steer: () => false, interrupt: () => false, approve: () => false, answer: () => false, cancel: () => finish() };
    } }),
  };
  const makeService = () => createTaskService(db, new Hub(), new ProcessSupervisor(1), backend, new WorktreeManager(), new LocalAttachmentStorage(db),
    new LocalRepositoryPaths(), new LocalNativeSessionAdapter(db.path), new NodeIdentifierGenerator());
  let service = makeService(); await service.init();
  t.after(() => { service.beginShutdown(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    db, starts, get service() { return service; },
    request: () => ({ requestId: randomUUID(), expectedRevision: service.getTask("t").messageQueue?.revision ?? 0 }),
    restart: async () => { service.beginShutdown(); service = makeService(); await service.init(); },
    complete: async (failed = false) => {
      if (failed) emit({ taskId: "t", sessionId: "session", kind: "error", payload: { message: "Provider unavailable" } }, 1);
      emit({ taskId: "t", sessionId: "session", kind: "result", payload: { is_error: failed } }, 2);
      finish(); await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test("compaction preserves session and history, deduplicates requests, and excludes competing writes", async t => {
  const f = await fixture(t), request = f.request();
  f.service.compact("t", request);
  assert.equal(f.starts[0].operation, "compact");
  assert.equal(f.starts[0].prompt, "");
  assert.equal(f.starts[0].resumeId, "session");
  assert.equal(f.service.getTask("t").messageQueue?.compaction?.status, "running");
  f.service.compact("t", request);
  assert.equal(f.starts.length, 1);
  assert.throws(() => f.service.compact("t", f.request()), /in progress/);
  assert.throws(() => f.service.steer("t", "Do something else"), /compaction/);
  assert.throws(() => f.service.submitMessage("t", { clientMessageId: randomUUID(), text: "New message", mode: "send", expectedRunId: f.service.getTask("t").messageQueue!.runId }), /compaction/);
  await f.complete();
  assert.equal(f.service.getTask("t").status, "idle");
  assert.equal(f.service.getTask("t").prompt, "Original conversation");
  assert.equal(f.service.getTask("t").sessionId, "session");
  assert.equal(f.service.getTask("t").messageQueue?.compaction?.status, "completed");
  assert.equal(f.service.taskHistory("t").events.filter(row => (row.event.payload as { subtype?: string }).subtype === "context_compacted").length, 1);
  await f.restart();
  f.service.compact("t", request);
  assert.equal(f.starts.length, 1, "a completed receipt survives restart");
  f.service.compact("t", f.request()); await f.complete();
  assert.throws(() => f.service.compact("t", request), /session changed/, "an older retry cannot compact a later revision");
});

test("compaction reattaches after replacement and exposes provider failure for explicit retry", async t => {
  const f = await fixture(t);
  f.service.compact("t", f.request());
  await f.restart();
  assert.equal(f.starts[1].reattach, true);
  assert.equal(f.starts[1].operation, "compact");
  await f.complete(true);
  assert.deepEqual(f.service.getTask("t").messageQueue?.compaction, { requestId: f.db.readMessageState("t")!.compaction!.requestId, status: "failed", error: "Provider unavailable" });
  assert.equal(f.service.getTask("t").status, "failed");
  f.service.compact("t", f.request()); await f.complete();
  assert.equal(f.service.getTask("t").messageQueue?.compaction?.status, "completed");
});

test("Stop during compaction leaves a resumable session and never reports success", async t => {
  const f = await fixture(t);
  f.service.compact("t", f.request());
  f.service.stop("t");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.service.getTask("t").status, "idle");
  assert.equal(f.service.getTask("t").interrupted, true);
  assert.equal(f.service.getTask("t").messageQueue?.compaction?.status, "failed");
  assert.equal(f.service.getTask("t").sessionId, "session");
});

for (const patch of [{ agent: "claude" }, { sessionId: undefined }, { status: "running" }, { status: "archived" },
  { sessionControl: { owner: "local", home: "/tmp/provider", transcript: "/tmp/session.jsonl", cursor: 0, prefixHash: "" } }] as Partial<TaskState>[]) {
  test(`compaction rejects unavailable session: ${JSON.stringify(patch)}`, async t => {
    const f = await fixture(t, patch);
    // Recovery resets an orphaned running task; represent a newly active turn here.
    if (patch.status === "running") f.service.getTask("t").status = "running";
    assert.throws(() => f.service.compact("t", f.request()));
    assert.equal(f.starts.length, 0);
  });
}
