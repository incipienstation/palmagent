import { test, expect, type Page } from "@playwright/test";
import { assertViewportLocked, openSessionDetails } from "./_helpers";
import { installScopedStream, open, send } from "./_scoped-stream";

const viewport = (page: Page) => page.locator('[data-radix-scroll-area-viewport][aria-label="Session transcript"]').first();

test("growing work stays folded, preserves reading state and summarizes tool failures", async ({ page }) => {
  await installScopedStream(page);
  await open(page, "t-run");
  await send(page, "t-run", { type: "tasks", tasks: [], historyThrough: 0 });
  let seq = 0;
  const emit = async (kind: string, payload: unknown) => send(page, "t-run", { type: "event", event: {
    taskId: "t-run", agent: "codex", ts: seq, kind, payload,
  } }, ++seq);
  await emit("assistant_text", { text: "Checking project files. ".repeat(12), phase: "progress", messageId: "progress-1" });
  for (let i = 0; i < 20; i++) {
    await emit("tool_call", { id: `tool-${i}`, name: "bash", command: "echo checked" });
    await emit("tool_result", { tool_use_id: `tool-${i}`, output: `Full tool output ${i}`, exit_code: 0 });
  }
  await expect(page.locator("[data-activity]")).toHaveCount(1);
  await expect(page.getByText("Full tool output 0", { exact: false })).toHaveCount(0);
  const preview = page.locator("[data-progress-preview]");
  expect(await preview.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(24);
  const group = page.locator("[data-activity]").getByRole("button").first();
  await group.focus();
  await page.keyboard.press("Enter");
  await expect(group).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "Completed: echo checked", exact: true }).first().click();
  await expect(page.getByText("Full tool output 0", { exact: false })).toBeVisible();
  // The reader scrolls after expansion has finished changing row heights.
  await page.locator("[data-activity]").evaluate(async el => {
    await Promise.all(el.getAnimations({ subtree: true })
      .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {})));
  });
  await expect.poll(() => viewport(page).evaluate(async el => {
    const height = el.scrollHeight;
    for (let frame = 0; frame < 4; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (el.scrollHeight !== height) return false;
    }
    return true;
  })).toBe(true);
  await viewport(page).evaluate((el) => { el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })); el.scrollTop = 50; el.dispatchEvent(new Event("scroll")); });
  // Establish a painted reading position after the expansion's measurements,
  // then verify the next event preserves it.
  const readingPositions = await viewport(page).evaluate(async el => {
    const positions: number[] = [];
    for (let frame = 0; frame < 4; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      positions.push(el.scrollTop);
    }
    return positions;
  });
  expect(readingPositions).toEqual([50, 50, 50, 50]);
  await emit("tool_call", { id: "next-tool", name: "bash", command: "echo more" });
  await expect(group).toHaveAttribute("aria-expanded", "true");
  expect(await viewport(page).evaluate((el) => el.scrollTop)).toBe(50);
  await group.click();
  await emit("tool_result", { tool_use_id: "next-tool", output: "Test command failed", exit_code: 1 });
  await expect(page.getByText("Tool failed — expand for details")).toHaveCount(0);
  await expect(group).toHaveAccessibleName("Activity · 21 tools");
  await expect(group.locator("[data-slot=trace-line]")).not.toHaveAttribute("data-status", "error");
  await emit("question", { questions: [{ question: "Which target?", options: [{ label: "Preview" }] }] });
  await expect(page.getByText("Which target?", { exact: true })).toBeVisible();
  await emit("status", { subtype: "answer", answers: [{ selected: ["Preview"] }] });
  await emit("assistant_text", { text: "Finished checking.", phase: "final", messageId: "final-1" });
  await emit("result", { result: "Finished checking." });
  await expect(page.getByText("Finished checking.", { exact: true })).toHaveCount(1);
  await expect(page.locator("[data-progress-preview]")).toHaveCount(0);
  await assertViewportLocked(page);
});

test("repeated tool failures and an interrupted run stay readable on mobile", async ({ page }) => {
  await installScopedStream(page);
  await open(page, "t-run");
  await send(page, "t-run", { type: "tasks", tasks: [], historyThrough: 0 });
  let seq = 0;
  const emit = (kind: string, payload: unknown) => send(page, "t-run", { type: "event", event: {
    taskId: "t-run", agent: "codex", ts: seq, kind, payload,
  } }, ++seq);
  await emit("status", { subtype: "turn_started" });
  for (let i = 0; i < 12; i++) {
    await emit("tool_call", { id: `failed-${i}`, name: "bash", command: `check-target-${i}` });
    await emit("tool_result", { tool_use_id: `failed-${i}`, output: `Diagnostic ${i}: target unavailable`, exit_code: 1 });
  }
  await emit("error", { message: "Codex exited before a terminal turn result." });
  await emit("result", { is_error: true, subtype: "failed" });
  await emit("status", { subtype: "process_exit", code: 1 });
  const { tasks } = await (await page.request.get("/api/tasks")).json();
  const task = tasks.find((task: { taskId: string }) => task.taskId === "t-run");
  await send(page, "t-run", { type: "tasks", tasks: [{ ...task, status: "failed" }] });
  await openSessionDetails(page);
  const sessionDetails = page.getByRole("dialog", { name: "Session details" });
  await expect(sessionDetails.getByText("Failed", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sessionDetails).toBeHidden();
  const summary = page.locator("[data-run-failure]");
  await expect(summary).toHaveCount(1);
  await expect(summary).toHaveAttribute("aria-label", "Run interrupted");
  await expect(page.getByText("Tool failed — expand for details")).toHaveCount(0);
  await expect(page.getByText("Codex exited before a terminal turn result.")).toHaveCount(0);
  await expect(page.locator("[data-activity]")).toHaveCount(1);
  await assertViewportLocked(page);
  const details = summary.getByRole("button");
  await details.focus();
  await page.keyboard.press("Enter");
  await expect(details).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Codex exited before a terminal turn result.", { exact: false })).toBeVisible();
  await details.click();
  await expect(details).toHaveAttribute("aria-expanded", "false");
  const activity = page.getByRole("button", { name: "Activity · 12 tools", exact: true });
  await activity.click();
  await page.getByRole("button", { name: "Failed: check-target-0", exact: true }).click();
  await expect(page.getByText("Diagnostic 0: target unavailable", { exact: false })).toBeVisible();
  await activity.click();
  await expect(page.getByText("Diagnostic 0: target unavailable", { exact: false })).toHaveCount(0);
  await emit("status", { subtype: "followup", text: "Continue" });
  await emit("status", { subtype: "turn_started" });
  await emit("assistant_text", { text: "Finished the remaining work.", phase: "final" });
  await emit("result", { result: "Finished the remaining work." });
  await send(page, "t-run", { type: "tasks", tasks: [{ ...task, status: "idle" }] });
  await openSessionDetails(page);
  await expect(sessionDetails.getByText("Done", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sessionDetails).toBeHidden();
  await expect(summary).toHaveAttribute("aria-label", "Previous run interrupted");
  await expect(summary).toHaveAttribute("role", "group");
  await expect(page.getByText("Finished the remaining work.", { exact: true })).toBeVisible();
  await expect(page.getByText("Send a follow-up to continue.", { exact: false })).toHaveCount(0);
  await assertViewportLocked(page);
});
