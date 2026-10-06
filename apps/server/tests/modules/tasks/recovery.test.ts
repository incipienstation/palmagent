import assert from "node:assert/strict";
import test from "node:test";
import { recoverTasks } from "../../../src/modules/tasks/application/use-cases/recover-tasks.js";
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
