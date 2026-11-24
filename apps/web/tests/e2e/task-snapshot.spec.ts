import { test, expect } from "@playwright/test";
import { tasks } from "../fixtures.mjs";
import { applyTaskChanges, reconcileTasks } from "../../src/task-snapshot";

test("unchanged snapshots reuse rows while nested changes, order and removals remain authoritative", () => {
  const previous = structuredClone(tasks);
  expect(reconcileTasks(previous, structuredClone(previous))).toBe(previous);
  const changed = structuredClone(previous);
  changed[0].pendingInput!.questions[0].question = "A newly arrived question";
  const next = reconcileTasks(previous, changed);
  expect(next).not.toBe(previous);
  expect(next[0]).toBe(changed[0]);
  expect(next[1]).toBe(previous[1]);
  expect(next[0].updatedAt).toBe(previous[0].updatedAt);
  const reversed = reconcileTasks(previous, structuredClone(previous).reverse());
  expect(reversed[0]).toBe(previous.at(-1));
  expect(reconcileTasks(previous, [])).toEqual([]);
  expect(reconcileTasks(previous, [changed[0]])).toEqual([changed[0]]);
});

test("inbox deltas preserve untouched rows, remove deleted tasks and insert new tasks in snapshot order", () => {
  const [first, second] = tasks;
  const added = { ...second, taskId: "new", createdAt: first.createdAt - 1 };
  const next = applyTaskChanges([first, second], { type: "task-changes", tasks: [added], removed: [second.taskId] });
  expect(next).toEqual([added, first]);
  expect(next[1]).toBe(first);
  const renamed = { ...first, title: "Updated" };
  expect(applyTaskChanges(next, { type: "task-changes", tasks: [renamed], removed: [] })).toEqual([added, renamed]);
});
