import { test, expect } from "@playwright/test";
import type { PendingMessage } from "@palmagent/shared";
import type { LogItem } from "../../src/hooks/useTaskStream";
import { transcriptActivity } from "../../src/transcript-activity";
import { presentTranscript } from "../../src/transcript";

const event = (kind: Exclude<LogItem["kind"], "assistant_text">, payload: unknown = {}): LogItem =>
  ({ key: 1, kind, event: { taskId: "task", agent: "codex", kind, payload, ts: 1 } });
const status = (subtype: string, extra = {}) => event("status", { subtype, ...extra });
const prose = (text = "Answer", extra = {}): LogItem => ({ key: 2, kind: "assistant_text", agent: "codex", text, ...extra });
const active = { running: true };
const sending = { id: "send-1", text: "Continue", mode: "send", status: "sending", version: 1 } as PendingMessage;

test("output supersedes lifecycle waiting and metadata cannot restart it", () => {
  const log = [status("turn_started")];
  expect(transcriptActivity(log, active)).toBe("working");
  expect(presentTranscript(log, "compact", true)).toEqual([]);
  for (const phase of [undefined, "progress", "final"]) {
    const output = [...log, prose("Answer", { messageId: "m1", phase })];
    expect(transcriptActivity(output, active)).toBe("output");
    for (const metadata of [status("usage"), status("assistant_message", { messageId: "m1", phase: "final" }),
      status("stderr"), status("message_delivered"), status("rate_limit"), prose("")]) {
      expect(transcriptActivity([...output, metadata], active)).toBe("output");
    }
  }
});

test("only new work resumes waiting after output, even with older text in view", () => {
  for (const work of [event("tool_call"), event("tool_result"), status("reasoning")]) {
    const log = [prose(), work];
    expect(transcriptActivity(log, active)).toBe("working");
    expect(transcriptActivity([...log, prose("Next response")], active)).toBe("output");
  }
  expect(transcriptActivity([event("output_image"), status("usage")], active)).toBe("output");
});

test("input waits survive metadata and background tools until explicitly resolved", () => {
  for (const request of [event("question"), event("approval_request")]) {
    const log = [prose(), request, status("usage"), event("tool_result")];
    expect(transcriptActivity(log, active)).toBe("blocked");
    for (const resolved of ["answer", "approval", "input_resolved"]) {
      expect(transcriptActivity([...log, status(resolved)], active)).toBe("working");
    }
    expect(transcriptActivity([...log, status("turn_started")], active)).toBe("working");
  }
  expect(transcriptActivity([status("turn_started")], { ...active, blocked: true, messages: [sending] })).toBe("blocked");
});

test("terminal and stop events stay ended through trailing metadata until a new turn", () => {
  for (const terminal of [event("result"), event("error"), status("process_exit"), status("stop"), status("error")]) {
    const log = [prose(), terminal, status("usage"), event("tool_result"), status("reasoning")];
    expect(transcriptActivity(log, active)).toBe("ended");
    expect(transcriptActivity([...log, status("followup")], active)).toBe("working");
  }
});

test("delivery acknowledgment lets newer output outrank a stale sending receipt", () => {
  const options = { running: false, messages: [sending] };
  expect(transcriptActivity([prose(), event("result")], options)).toBe("working");
  const log = [status("followup", { messageId: sending.id })];
  expect(transcriptActivity(log, options)).toBe("working");
  expect(transcriptActivity([...log, prose(), status("usage")], options)).toBe("output");
  expect(transcriptActivity([...log, event("result"), status("usage")], options)).toBe("ended");
  expect(transcriptActivity([...log, prose()], { ...options, messages: [sending, { ...sending, id: "send-2" }] })).toBe("working");
});

test("idle, queue, failed delivery and history loading are not agent work", () => {
  for (const status of ["queued", "unknown", "rejected"] as const) {
    expect(transcriptActivity([], { running: false, messages: [{ ...sending, status }] })).toBe("idle");
  }
  expect(transcriptActivity([], { ...active, loading: true })).toBe("idle");
  expect(transcriptActivity([], { ...active, loading: true, messages: [sending] })).toBe("working");
  expect(transcriptActivity([status("turn_started")], { running: false })).toBe("idle");
});
