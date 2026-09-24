import { test, expect } from "@playwright/test";
import { presentTranscript, activityLabel, runInterrupted, type Activity } from "../../src/transcript";
import type { LogItem } from "../../src/hooks/useTaskStream";

const event = (key: number, kind: Exclude<LogItem["kind"], "assistant_text">, payload: unknown): LogItem =>
  ({ key, kind, event: { taskId: "task", agent: "claude", kind, payload, ts: key } });
const prose = (key: number, text: string, extra = {}): LogItem => ({ key, kind: "assistant_text", agent: "claude", text, ...extra });

test("late phase markers fold only their matching message and keep final text once", () => {
  const log = [prose(1, "Earlier explanation"), prose(2, "Reading files", { messageId: "m1" }),
    event(3, "status", { subtype: "assistant_message", messageId: "m1", phase: "progress" }),
    event(4, "tool_call", { name: "Read", id: "t1" }), event(5, "tool_result", { output: "Read output" }),
    prose(6, "Final answer", { messageId: "m2", phase: "final" }), event(7, "result", { result: "Final answer" })];
  const rows = presentTranscript(log, "compact", false);
  expect(rows.filter((r) => r.type === "message").map((r) => r.key)).toEqual([1, 6]);
  const group = rows.find((r): r is Activity => r.type === "activity")!;
  expect(group.items.map((it) => it.key)).toEqual([2, 3, 4, 5, 7]);
  expect(group.preview).toBeUndefined();
  expect(presentTranscript(log, "verbose", false)).toHaveLength(log.length);
});

test("questions, approvals, failures, images and repeated answers across turns survive", () => {
  const log = [event(1, "tool_call", { name: "bash", id: "t1" }),
    event(2, "tool_result", { exit_code: 1, output: "failure" }),
    event(3, "question", {}), event(4, "approval_request", {}), event(5, "output_image", {}),
    event(6, "result", { result: "Done" }), event(7, "status", { subtype: "followup", text: "Again" }),
    event(8, "result", { result: "Done" }), event(9, "result", { is_error: true, result: "Failed" }),
    event(10, "status", { subtype: "process_exit", code: 1 })];
  for (const mode of ["compact"] as const) {
    const rows = presentTranscript(log, mode, false);
    expect(rows.filter((r) => r.type === "message").map((r) => r.key)).toEqual([3, 4, 5, 6, 7, 8]);
  }
});

test("call lifecycle updates count as one failed tool inside activity", () => {
  const log = [event(1, "tool_call", { id: "t1", name: "bash", status: "in_progress" }),
    event(2, "tool_call", { id: "t1", name: "bash", status: "failed" }),
    event(3, "tool_result", { tool_use_id: "t1", exit_code: 1 })];
  const rows = presentTranscript(log, "compact", true);
  const group = rows[0] as Activity;
  expect(activityLabel(group, "compact")).toContain("1 tool");
  expect(activityLabel(group, "compact")).toBe("Working… · 1 tool · 1 failed");
  expect(group.items).toEqual(log);
  expect(rows).toHaveLength(1);
});

for (const mode of ["compact"] as const) {
  test(`${mode}: repeated failures stay folded and terminal signals share one run summary`, () => {
    const log = [event(1, "status", { subtype: "turn_started" }),
      ...Array.from({ length: 12 }, (_, i) => event(i + 2, "tool_result", { tool_use_id: `tool-${i}`, exit_code: 1, output: "failed command" })),
      event(14, "error", { message: "Runner disconnected" }),
      event(15, "result", { is_error: true }),
      event(16, "status", { subtype: "process_exit", code: 1 })];
    const rows = presentTranscript(log, mode, false);
    expect(rows.map((r) => r.type)).toEqual(["activity", "failure"]);
    const failure = rows.find((r) => r.type === "failure")!;
    expect(failure.items.map((item) => item.key)).toEqual([14, 15, 16]);
    expect(runInterrupted(failure)).toBe(true);
    expect(failure.previous).toBe(false);
    expect(presentTranscript(log, "verbose", false).map((r) => r.key)).toEqual(log.map((item) => item.key));

    const continued = presentTranscript([...log,
      event(17, "status", { subtype: "followup", text: "Continue" }),
      event(18, "status", { subtype: "turn_started" }),
      event(19, "tool_result", { exit_code: 1 }), prose(20, "Finished the remaining work")], mode, false);
    expect(continued.filter((r) => r.type === "failure")).toEqual([{ ...failure, previous: true }]);
    expect(continued.filter((r) => r.type === "message").map((r) => r.key)).toEqual([17, 20]);
  });
}

test("errors without tools stay accessible and questions or steering do not imply a new run", () => {
  const error = event(1, "error", { message: "Transient request error" });
  const rows = presentTranscript([error, event(2, "question", {}),
    event(3, "status", { subtype: "answer" }), event(4, "status", { subtype: "steer" }),
    event(5, "error", { message: "Still unavailable" })], "compact", true);
  const failure = rows.find((r) => r.type === "failure")!;
  expect(failure.items.map((item) => item.key)).toEqual([1, 5]);
  expect(failure.previous).toBe(false);
  expect(runInterrupted(failure)).toBe(false);
  const next = presentTranscript([error, event(2, "status", { subtype: "turn_started" }),
    event(3, "error", { message: "Codex exited before a terminal turn result." })], "compact", false);
  const failures = next.filter((r) => r.type === "failure");
  expect(failures.map((r) => r.previous)).toEqual([true, false]);
  expect(runInterrupted(failures[1])).toBe(true);
});

test("a successful terminal result quiets earlier errors without claiming their causes were resolved", () => {
  const rows = presentTranscript([event(1, "error", { message: "Temporary failure" }),
    event(2, "result", { is_error: true }), event(3, "result", { result: "Completed" })], "compact", false);
  const failure = rows.find((r) => r.type === "failure")!;
  expect(failure).toMatchObject({ completed: true, previous: false });
  expect(runInterrupted(failure)).toBe(false);
  expect(rows.filter((r) => r.type === "message").map((r) => r.key)).toEqual([3]);
});
