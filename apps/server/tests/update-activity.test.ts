import assert from "node:assert/strict";
import test from "node:test";
import type { TaskState } from "@palmagent/shared";
import { Hub } from "../src/hub.js";
import { bindUpdateActivity } from "../src/update-activity.js";

const task = (status: TaskState["status"]) => [{ status } as TaskState];
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("only idle transitions resume pending updates, including one arriving during an in-flight resume", async () => {
  const hub = new Hub();
  let pending = false;
  let calls = 0;
  let finish: (() => void) | undefined;
  const activity = bindUpdateActivity(hub, () => pending, async () => {
    calls++;
    if (calls === 1) await new Promise<void>((resolve) => { finish = resolve; });
  });
  hub.emitTasks(task("idle"));
  await turn();
  assert.equal(calls, 0);
  pending = true;
  for (const status of ["running", "queued", "awaiting_input", "awaiting_approval"] as const) hub.emitTasks(task(status));
  assert.equal(calls, 0);
  hub.emitTasks(task("idle"));
  assert.equal(calls, 1);
  hub.emitTasks(task("running"));
  hub.emitTasks(task("idle"));
  finish!();
  await turn();
  assert.equal(calls, 2, "a completion event is not lost behind the first request");
  hub.emitTasks(task("idle"));
  await turn();
  assert.equal(calls, 2, "repeated idle snapshots do not poll");
  activity.close();
  hub.emitTasks(task("running")); hub.emitTasks(task("idle"));
  await activity.wake();
  assert.equal(calls, 2);
});
