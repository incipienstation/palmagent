import { expect, test } from "@playwright/test";
import { createFinalReplyObserver } from "../../src/conversation-notifications";
import type { LogItem } from "../../src/hooks/useTaskStream";

const event = (key: number, kind: Exclude<LogItem["kind"], "assistant_text">, payload: unknown): LogItem =>
  ({ key, kind, event: { taskId: "task", agent: "claude", kind, payload, ts: key } });
const prose = (key: number, text: string, extra = {}): LogItem => ({ key, kind: "assistant_text", agent: "claude", text, ...extra });

test("unclassified prose waits for successful completion and progress alone never announces an answer", () => {
  const observe = createFinalReplyObserver();
  expect(observe(prose(1, "Investigating", { messageId: "work" }))).toBe(false);
  expect(observe(event(2, "status", { subtype: "assistant_message", messageId: "work", phase: "progress" }))).toBe(false);
  expect(observe(event(3, "result", { usage: {} }))).toBe(false);
  expect(observe(event(4, "status", { subtype: "turn_started" }))).toBe(false);
  expect(observe(prose(5, "An older provider's answer"))).toBe(false);
  expect(observe(event(6, "result", { usage: {} }))).toBe(true);
  expect(observe(event(7, "result", { result: "An older provider's answer" }))).toBe(false);
});

test("late final markers need matching meaningful text and cannot announce twice", () => {
  const observe = createFinalReplyObserver();
  expect(observe(prose(1, "Still working", { messageId: "work" }))).toBe(false);
  expect(observe(event(2, "status", { subtype: "assistant_message", messageId: "answer", phase: "final" }))).toBe(false);
  expect(observe(prose(3, "  ", { messageId: "answer" }))).toBe(false);
  expect(observe(prose(3, "Done", { messageId: "answer" }))).toBe(true);
  expect(observe(event(4, "status", { subtype: "assistant_message", messageId: "answer", phase: "final" }))).toBe(false);
  expect(observe(event(5, "result", { result: "Done" }))).toBe(false);
});

test("failed results and empty results do not invent final replies; new turns rearm notification", () => {
  const observe = createFinalReplyObserver();
  expect(observe(event(1, "result", {}))).toBe(false);
  expect(observe(event(2, "result", { is_error: true, result: "Failed" }))).toBe(false);
  expect(observe(event(3, "result", { result: "Completed answer" }))).toBe(true);
  expect(observe(event(4, "status", { subtype: "followup", text: "Next request" }))).toBe(false);
  expect(observe(prose(5, "Reading", { phase: "progress" }))).toBe(false);
  expect(observe(prose(6, "Next answer", { phase: "final" }))).toBe(true);
  expect(observe(prose(6, "Next answer, continued", { phase: "final" }))).toBe(false);
});
