import assert from "node:assert/strict";
import test from "node:test";
import type { TaskState } from "@palmagent/shared";
import { recoverTaskExecutions, recoverTasks } from "../../../src/modules/tasks/application/use-cases/recover-tasks.js";
import { projectConfirmedPrs } from "../../../src/modules/tasks/domain/pr-projection.js";
import { makePrRef } from "@palmagent/shared";

test("recovery resets only orphaned turns through one repository operation", () => {
  const writes: { ids: string[]; now: number }[] = [];
  const repository = { inFlightTaskIds: () => ["live", "orphan", "queued"], resetInterruptedTasks: (ids: string[], now: number) => { writes.push({ ids, now }); } };
  assert.deepEqual(recoverTasks(repository, 123, new Set(["live"])), ["orphan", "queued"]);
  assert.deepEqual(writes, [{ ids: ["orphan", "queued"], now: 123 }]);
  assert.deepEqual(recoverTasks(repository, 456, new Set(["live", "orphan", "queued"])), []);
  assert.equal(writes.length, 1);
});

test("PR rebuild requires creation evidence while preserving confirmed metadata and order", () => {
  const a = { ...makePrRef("https://github.com/example/app/pull/1")!, title: "Confirmed" };
  const b = makePrRef("https://github.com/example/app/pull/2")!;
  const c = "https://github.com/example/app/pull/3";
  assert.deepEqual(projectConfirmedPrs([a, b], [a.url, a.url, c], true), [a, makePrRef(c)]);
  assert.deepEqual(projectConfirmedPrs([a], [a.url, c]), [a, makePrRef(c)]);
  assert.deepEqual(projectConfirmedPrs([a, b], [], true), []);
});

function recoveryFixture() {
  const tasks = new Map<string, TaskState>();
  for (const [taskId, status] of [["live", "running"], ["orphan", "awaiting_input"], ["queued", "queued"], ["shared", "running"], ["cancelled", "cancelled"]] as const) {
    tasks.set(taskId, { taskId, status, repoId: "repo", agent: "codex", permission: "read-only", prompt: "fixture", interrupted: false,
      createdAt: 1, updatedAt: 1, lastActivityAt: 1 });
  }
  tasks.get("shared")!.sessionControl = { owner: "shared", home: "/fixture/home", transcript: "/fixture/session", cursor: 0, prefixHash: "" };
  const calls: unknown[] = [];
  const repository = {
    inFlightTaskIds: () => ["live", "orphan", "queued", "shared"], messageTaskIds: () => [...tasks.keys()],
    resetInterruptedTasks: (ids: string[], now: number) => { calls.push(["reset", ids, now]); },
  };
  const effects = {
    now: () => 42,
    reattach: (task: TaskState) => { calls.push(["reattach", task.taskId]); },
    recoverMessages: (id: string, live: boolean) => {
      calls.push(["messages", id, live, tasks.get(id)!.status]);
    },
  };
  return { tasks, calls, repository, effects };
}

test("recovery reattaches before resetting orphans and reconciling queues with the injected clock", async () => {
  const f = recoveryFixture();
  const result = await recoverTaskExecutions(f.repository, { listLive: async () => ["live", "queued", "unknown"] }, f.tasks, f.effects);
  assert.deepEqual(result, { reattached: ["live"], recovered: ["orphan", "queued"] });
  assert.deepEqual(f.calls, [
    ["reattach", "live"], ["reset", ["orphan", "queued"], 42],
    ["messages", "live", true, "running"], ["messages", "orphan", false, "idle"],
    ["messages", "queued", false, "idle"], ["messages", "shared", true, "running"],
    ["messages", "cancelled", false, "cancelled"],
  ]);
  assert.equal(f.tasks.get("orphan")!.interrupted, true);
});

test("independent recovery retains queued admission and cancelled execution journals", async () => {
  const f = recoveryFixture();
  const result = await recoverTaskExecutions(f.repository, {
    independent: true, listLive: async () => ["live", "orphan", "queued", "cancelled", "unknown"],
  }, f.tasks, f.effects);
  assert.deepEqual(result, { reattached: ["live", "orphan", "queued", "cancelled"], recovered: [] });
  assert.equal(f.calls.some(call => (call as unknown[])[0] === "reset"), false);
  assert.equal(f.tasks.get("queued")!.status, "queued");
});

for (const failure of ["missing", "unavailable", "reattach"]) test(`independent recovery fails closed on ${failure} execution evidence`, async () => {
  const f = recoveryFixture();
  if (failure === "reattach") f.effects.reattach = () => { throw new Error("reattach failed"); };
  await assert.rejects(recoverTaskExecutions(f.repository, {
    independent: true, listLive: async () => {
      if (failure === "unavailable") throw new Error("backend unavailable");
      return failure === "missing" ? ["live"] : ["live", "orphan", "queued"];
    },
  }, f.tasks, f.effects));
  assert.deepEqual(f.calls, [], "uncertain executions must not reset tasks or reconcile delivery as absent");
  assert.equal(f.tasks.get("orphan")!.status, "awaiting_input");
});

test("legacy backend loss and failed reattachment preserve resumable orphan recovery", async () => {
  for (const unavailable of [false, true]) {
    const f = recoveryFixture();
    f.effects.reattach = () => { throw new Error("runner unavailable"); };
    const result = await recoverTaskExecutions(f.repository, { listLive: async () => {
      if (unavailable) throw new Error("disconnected");
      return ["live"];
    } }, f.tasks, f.effects);
    assert.deepEqual(result, { reattached: [], recovered: ["live", "orphan", "queued"] });
    assert.equal(f.tasks.get("shared")!.status, "running");
    assert.equal(f.tasks.get("live")!.interrupted, true);
  }
});
