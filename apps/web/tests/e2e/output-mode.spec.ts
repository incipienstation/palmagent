import { test, expect, type Page } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";
import { installScopedStream, open, send } from "./_scoped-stream";

const ONLY_WHEN_EXPANDED = "zero 503s under the new nginx.conf";
const viewport = (page: Page) => page.locator("[data-radix-scroll-area-viewport]").first();

for (const mode of ["compact", "verbose"] as const) {
  test(`${mode}: output density and full record access on mobile`, async ({ page }) => {
    await page.addInitScript((mode) => localStorage.setItem("pref:output-mode", mode), mode);
    await page.goto("/#/task/t-idle-nginx");
    if (mode !== "verbose") {
      await expect(page.getByText(ONLY_WHEN_EXPANDED)).toHaveCount(0);
      await expect(page.getByText("session started")).toHaveCount(0);
      // Legacy prose has no phase metadata and must remain readable.
      await expect(page.getByText("Adding a per-IP")).toBeVisible();
      await expect(page.getByText("Per-IP rate limit added; SSE stream verified unthrottled.", { exact: true })).toBeVisible();
      await expect(page).toHaveScreenshot(`output-mode-${mode}.png`);
      await page.getByRole("button", { name: /(?:Activity|Commands) · 1 tool$/ }).click();
    }
    await expect(page.getByText(ONLY_WHEN_EXPANDED)).toBeVisible();
    await assertViewportLocked(page);
    expect(await viewport(page).evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  });
}

test("compact keeps account limits visible and configuration in session details", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pref:output-mode", "compact"));
  await page.goto("/#/task/t-idle-rich");
  await expect(page.getByRole("button", { name: /Latest usage/ })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Task usage" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Account limits" }).getByText("72%", { exact: true })).toBeVisible();
  await page.getByTitle("Session details", { exact: true }).click();
  const detail = page.getByRole("dialog");
  await expect(detail.getByText("Permission", { exact: true })).toBeVisible();
  await expect(detail.getByText("Model", { exact: true })).toBeVisible();
  await assertViewportLocked(page);
});

for (const mode of ["compact"] as const) {
  test(`${mode}: growing work stays folded, preserves reading state and summarizes tool failures`, async ({ page }) => {
    await page.addInitScript((mode) => localStorage.setItem("pref:output-mode", mode), mode);
    await installScopedStream(page);
    await open(page, "t-run");
    await send(page, "t-run", { type: "tasks", tasks: [], replayThrough: 0 });
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
    expect(await preview.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThanOrEqual(mode === "compact" ? 24 : 42);
    const group = page.locator("[data-activity]").getByRole("button").first();
    await group.focus();
    await page.keyboard.press("Enter");
    await expect(group).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("Full tool output 0", { exact: false })).toBeVisible();
    await viewport(page).evaluate((el) => { el.scrollTop = 50; el.dispatchEvent(new Event("scroll")); });
    await emit("tool_call", { id: "next-tool", name: "bash", command: "echo more" });
    await expect(group).toHaveAttribute("aria-expanded", "true");
    expect(await viewport(page).evaluate((el) => el.scrollTop)).toBe(50);
    await group.click();
    await emit("tool_result", { tool_use_id: "next-tool", output: "Test command failed", exit_code: 1 });
    await expect(page.getByText("Tool failed — expand for details")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /1 failed/ })).toBeVisible();
    await emit("question", { questions: [{ question: "Which target?", options: [{ label: "Preview" }] }] });
    await expect(page.getByText("Which target?", { exact: true })).toBeVisible();
    await emit("status", { subtype: "answer", answers: [{ selected: ["Preview"] }] });
    await emit("assistant_text", { text: "Finished checking.", phase: "final", messageId: "final-1" });
    await emit("result", { result: "Finished checking." });
    await expect(page.getByText("Finished checking.", { exact: true })).toHaveCount(1);
    await expect(page.locator("[data-progress-preview]")).toHaveCount(0);
    await assertViewportLocked(page);
  });
}

test("late classification preserves open activity and separate assistant messages", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pref:output-mode", "compact"));
  await installScopedStream(page);
  await open(page, "t-run");
  await send(page, "t-run", { type: "tasks", tasks: [], replayThrough: 0 });
  let seq = 0;
  const emit = (kind: string, payload: unknown) => send(page, "t-run", { type: "event", event: {
    taskId: "t-run", agent: "claude", ts: seq, kind, payload,
  } }, ++seq);
  await emit("assistant_text", { text: "Inspecting files", messageId: "m1" });
  await emit("tool_call", { id: "t1", name: "Read", input: { file_path: "README.md" } });
  await page.locator("[data-activity]").getByRole("button").first().click();
  await emit("status", { subtype: "assistant_message", messageId: "m1", phase: "progress" });
  await expect(page.locator("[data-activity]").getByRole("button").first()).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("[data-activity]").getByText("Inspecting files", { exact: true })).toBeVisible();
  await page.locator("[data-activity]").getByRole("button").first().click();
  await emit("assistant_text", { text: "Final ", messageId: "m2" });
  await emit("assistant_text", { text: "answer", messageId: "m2" });
  await emit("assistant_text", { text: "A separate message", messageId: "m3" });
  await emit("result", { result: "Final answer" });
  await expect(page.getByText("Final answer", { exact: true })).toHaveCount(1);
  await expect(page.getByText("A separate message", { exact: true })).toHaveCount(1);
  await expect(page.locator("[data-progress-preview]")).toHaveCount(0);
});

for (const mode of ["compact"] as const) {
  test(`${mode}: repeated tool failures and an interrupted run stay readable on mobile`, async ({ page }) => {
    await page.addInitScript((mode) => localStorage.setItem("pref:output-mode", mode), mode);
    await installScopedStream(page);
    await open(page, "t-run");
    await send(page, "t-run", { type: "tasks", tasks: [], replayThrough: 0 });
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
    await expect(page.getByText("Failed", { exact: true })).toBeVisible();
    const summary = page.locator("[data-run-failure]");
    await expect(summary).toHaveCount(1);
    await expect(summary).toHaveAttribute("aria-label", "Run interrupted");
    await expect(page.getByText("Tool failed — expand for details")).toHaveCount(0);
    await expect(page.getByText("Codex exited before a terminal turn result.")).toHaveCount(0);
    await expect(page.locator("[data-activity]")).toHaveCount(1);
    await assertViewportLocked(page);
    if (mode === "compact") await expect(page).toHaveScreenshot("run-interrupted-folded.png");
    const details = summary.getByRole("button");
    await details.focus();
    await page.keyboard.press("Enter");
    await expect(details).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("Codex exited before a terminal turn result.", { exact: false })).toBeVisible();
    await details.click();
    await expect(details).toHaveAttribute("aria-expanded", "false");
    const activity = page.getByRole("button", { name: /12 tools · 12 failed/ });
    await activity.click();
    await expect(page.getByText("Diagnostic 0: target unavailable", { exact: false })).toBeVisible();
    await activity.click();
    await expect(page.getByText("Diagnostic 0: target unavailable", { exact: false })).toHaveCount(0);
    await emit("status", { subtype: "followup", text: "Continue" });
    await emit("status", { subtype: "turn_started" });
    await emit("assistant_text", { text: "Finished the remaining work.", phase: "final" });
    await emit("result", { result: "Finished the remaining work." });
    await send(page, "t-run", { type: "tasks", tasks: [{ ...task, status: "idle" }] });
    await expect(page.getByText("Done", { exact: true })).toBeVisible();
    await expect(summary).toHaveAttribute("aria-label", "Previous run interrupted");
    await expect(summary).toHaveAttribute("role", "group");
    await expect(page.getByText("Finished the remaining work.", { exact: true })).toBeVisible();
    await expect(page.getByText("Send a follow-up to continue.", { exact: false })).toHaveCount(0);
    await assertViewportLocked(page);
    if (mode === "compact") await expect(page).toHaveScreenshot("previous-run-error.png");
  });
}
