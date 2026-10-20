import assert from "node:assert/strict";
import test from "node:test";
import { appendHistoryEvent, projectConversation, traceOperations, type AgentEvent, type LogItem } from "@palmagent/shared";

function log(events: Array<[AgentEvent["kind"], unknown, string?]>, agent: "claude" | "codex" = "codex") {
  const items: LogItem[] = [];
  events.forEach(([kind, payload, sessionId], index) => appendHistoryEvent(items,
    { taskId: "task", agent, kind, payload, sessionId, ts: index } as AgentEvent, index + 1));
  return items;
}

test("repeated provider updates retain one operation identity and the explicit terminal result", () => {
  const items = log([
    ["tool_call", { id: "a", name: "bash", command: "pnpm test", status: "in_progress" }],
    ["tool_call", { id: "a", name: "bash", command: "pnpm test", status: "completed" }],
    ["tool_result", { tool_use_id: "a", output: "Passed", exit_code: 0, status: "completed" }],
  ]);
  assert.deepEqual(traceOperations(items, true), [{ key: 1, kind: "tool", title: "pnpm test", state: "completed", members: [1, 2, 3] }]);
});

test("call identifiers never correlate across runs, providers or sessions; missing IDs remain separate", () => {
  const items = log([
    ["tool_call", { id: "a", name: "Read" }, "one"],
    ["tool_result", { tool_use_id: "a", output: "other session" }, "two"],
    ["status", { subtype: "turn_started" }],
    ["tool_result", { tool_use_id: "a", output: "other run" }, "one"],
    ["tool_call", { name: "Read" }], ["tool_result", { output: "unidentified" }],
  ]);
  assert.equal(traceOperations(items, false).length, 5);
  assert.equal(traceOperations(items, false)[0].state, "unknown");
  const mixed = log([["tool_call", { id: "a", name: "Read" }]]);
  appendHistoryEvent(mixed, { taskId: "task", agent: "claude", kind: "tool_result", payload: { tool_use_id: "a" }, ts: 2 }, 2);
  assert.equal(traceOperations(mixed, true).length, 2);
});

test("missing results are unknown after successful completion and interrupted after abnormal exit", () => {
  const call: [AgentEvent["kind"], unknown] = ["tool_call", { id: "a", name: "Read" }];
  assert.equal(traceOperations(log([call]), true)[0].state, "running");
  assert.equal(traceOperations(log([call]), false)[0].state, "unknown");
  assert.equal(traceOperations(log([call, ["result", {}]]), true)[0].state, "unknown");
  assert.equal(traceOperations(log([call, ["status", { subtype: "process_exit", code: 1 }]]), false)[0].state, "interrupted");
  assert.equal(traceOperations(log([call, ["tool_result", { tool_use_id: "a", status: "cancelled" }]]), false)[0].state, "interrupted");
});

test("a late result updates its original operation without moving replies or duplicating activity", () => {
  const items = log([
    ["tool_call", { id: "a", name: "Read" }],
    ["assistant_text", { text: "A partial answer", phase: "partial" }],
    ["tool_result", { tool_use_id: "a", output: "Done" }],
    ["assistant_text", { text: "Final answer", phase: "final" }],
  ]);
  const rows = projectConversation(items, false);
  assert.deepEqual(rows.map(row => row.type), ["activity", "message", "message"]);
  const activity = rows[0];
  assert.equal(activity.type, "activity");
  if (activity.type === "activity") assert.deepEqual(activity.operations?.[0].members, [1, 3]);
});

test("intermediate images stay inside their tool trace while explicit message images stay visible", () => {
  const items = log([
    ["tool_call", { id: "image", name: "view_image" }, "one"],
    ["tool_result", { tool_use_id: "image", content: "Image output" }, "one"],
    ["output_image", { tool_use_id: "image", data: "fixture" }, "one"],
    ["assistant_text", { text: "Final answer", phase: "final" }, "one"],
    ["output_image", { source: "message", data: "final" }, "one"],
  ]);
  const rows = projectConversation(items, false);
  assert.deepEqual(rows.map(row => row.type), ["activity", "message", "message"]);
  const activity = rows[0];
  assert.equal(activity.type, "activity");
  if (activity.type === "activity") assert.deepEqual(activity.operations, [
    { key: 1, kind: "tool", title: "view_image", state: "completed", members: [1, 2, 3] },
  ]);
});

test("legacy and unmatched images remain accessible in Trace without inventing tool ownership", () => {
  const items = log([
    ["tool_call", { id: "image", name: "view_image" }, "one"],
    ["output_image", { tool_use_id: "image", data: "different session" }, "two"],
    ["output_image", { data: "legacy" }, "one"],
  ]);
  const rows = projectConversation(items, false);
  assert.deepEqual(rows.map(row => row.type), ["activity"]);
  assert.deepEqual(traceOperations(items, false).map(step => step.members), [[1], [2], [3]]);
});
