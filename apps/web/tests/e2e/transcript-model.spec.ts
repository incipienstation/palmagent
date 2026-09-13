import { test, expect } from "@playwright/test";
import { presentTranscript, activityLabel, type Activity } from "../../src/transcript";
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
  for (const mode of ["compact", "default"] as const) {
    const rows = presentTranscript(log, mode, false);
    expect(rows.filter((r) => r.type === "message").map((r) => r.key)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
  }
});

test("call lifecycle updates count as one tool and failed calls remain visible", () => {
  const log = [event(1, "tool_call", { id: "t1", name: "bash", status: "in_progress" }),
    event(2, "tool_call", { id: "t1", name: "bash", status: "failed" }),
    event(3, "tool_result", { tool_use_id: "t1", exit_code: 1 })];
  const rows = presentTranscript(log, "compact", true);
  const group = rows[0] as Activity;
  expect(activityLabel(group, "compact")).toContain("1 tool");
  expect(rows.filter((r) => r.type === "message").map((r) => r.key)).toEqual([2, 3]);
});
