import { test as base, expect, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, TaskState } from "@palmagent/shared";
import { openDatabase } from "../../../server/src/platform/sqlite/connection";
import { SqliteSpaces } from "../../../server/src/modules/spaces/adapters/outbound/sqlite-spaces";
import { SqliteTasks } from "../../../server/src/modules/tasks/adapters/outbound/sqlite-tasks";
import { installScopedStream, send, type Harness } from "./_scoped-stream";
import { assertViewportLocked, captureForReview } from "./_helpers";

const taskId = "t-idle-rich";
const event = (kind: AgentEvent["kind"], payload: unknown) => ({ taskId, agent: "codex", kind, payload, ts: 1 } as AgentEvent);
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "palmagent-trace-browser-"));
  const db = openDatabase(join(directory, "history.sqlite")), spaces = new SqliteSpaces(db), tasks = new SqliteTasks(db);
  spaces.insertRepo({ id: "space", name: "Fixture", path: directory, vcs: "none", defaultBaseRef: "", createdAt: 1 });
  const task: TaskState = { taskId, repoId: "space", agent: "codex", prompt: "Fixture", status: "idle", interrupted: false,
    permission: "default", createdAt: 1, updatedAt: 1, lastActivityAt: 1 };
  tasks.insertTask(task);
  return { tasks, task, add: (events: AgentEvent[]) => tasks.appendAgentEvents(taskId, events),
    close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}
type History = ReturnType<typeof fixture>;
const test = base.extend<{ history: History }>({ history: async ({}, use) => { const h = fixture(); try { await use(h); } finally { h.close(); } } });
test.use({ serviceWorkers: "block" });
async function routes(page: Page, history: History) {
  await installScopedStream(page);
  const requests: string[] = [];
  await page.route(new RegExp(`/api/tasks/${taskId}/history(?:/[^?]+)?(?:\\?.*)?$`), async route => {
    const url = new URL(route.request().url()), q = url.searchParams;
    const name = url.pathname.split("/history")[1]; requests.push(name || "summary");
    const key = Number(q.get("key")), after = Number(q.get("after") ?? 0);
    let result;
    if (!name) result = history.tasks.conversationPage(taskId, q.has("before") ? Number(q.get("before")) : undefined);
    else if (name === "/changes") result = history.tasks.conversationChanges(taskId, after, Number(q.get("through")), q.has("afterKey") ? Number(q.get("afterKey")) : undefined);
    else if (name === "/steps") result = history.tasks.conversationSteps(taskId, key, after);
    else if (name === "/step-details") result = history.tasks.conversationStepDetails(taskId, key, Number(q.get("step")), after);
    else if (name === "/content") result = history.tasks.conversationContent(taskId, key, q.get("version")!, Number(q.get("offset")), q.has("member") ? Number(q.get("member")) : undefined);
    else if (name === "/records") result = history.tasks.executionRecords(taskId, q.has("before") ? Number(q.get("before")) : undefined);
    else if (name === "/record-content") result = history.tasks.executionRecordContent(taskId, key, q.get("version")!, Number(q.get("offset")));
    else return route.fallback();
    return route.fulfill({ json: result });
  });
  return requests;
}
const pair = (i: number) => [event("tool_call", { id: `call-${i}`, name: "bash", command: `check-${i}` }), event("tool_result", { tool_use_id: `call-${i}`, output: `Output for step ${i}`, exit_code: 0 })];

for (const oldPreference of ["compact", "verbose"]) test(`one chat view ignores the old ${oldPreference} preference and loads only selected details`, async ({ page, history }) => {
  history.add([event("status", { subtype: "followup", text: "Inspect the project" }), ...pair(0), ...pair(1), event("assistant_text", { text: "Inspection complete", phase: "final" }), event("result", {})]);
  const requests = await routes(page, history);
  await page.addInitScript(value => localStorage.setItem("pref:output-mode", value), oldPreference);
  await page.goto(`/#/task/${taskId}`);
  const activity = page.getByRole("button", { name: "Activity · 2 tools", exact: true });
  await expect(activity).toBeVisible();
  expect(requests).toEqual(["summary"]);
  await activity.focus(); await page.keyboard.press("Enter");
  const step = page.getByRole("button", { name: "Completed: check-0", exact: true });
  await expect(step).toBeVisible();
  expect(requests).toEqual(["summary", "/steps"]);
  await expect(page.getByText("Output for step 0", { exact: false })).toHaveCount(0);
  await step.focus(); await page.keyboard.press("Enter");
  await expect(page.getByText("Output for step 0", { exact: false })).toBeVisible();
  await expect(page.getByText("Output for step 1", { exact: false })).toHaveCount(0);
  expect(requests.filter(name => name === "/step-details")).toHaveLength(1);
  await activity.click(); await activity.click();
  await expect(step).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Output for step 0", { exact: false })).toBeVisible();
  await assertViewportLocked(page);
  await captureForReview(page, `trace-${oldPreference}.png`);
});

test("expanding loaded steps does not load the next page or unseen output", async ({ page, history }) => {
  history.add(Array.from({ length: 55 }, (_, i) => pair(i)).flat());
  const requests = await routes(page, history);
  await page.goto(`/#/task/${taskId}`);
  await page.getByRole("button", { name: "Activity · 55 tools", exact: true }).click();
  await page.getByRole("button", { name: "Expand loaded steps", exact: true }).click();
  await expect.poll(() => requests.filter(name => name === "/step-details").length).toBe(50);
  expect(requests.filter(name => name === "/steps")).toHaveLength(1);
  await expect(page.getByText("Output for step 54", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Collapse loaded steps", exact: true }).click();
  await page.getByRole("button", { name: "Load more steps", exact: true }).click();
  await expect(page.getByRole("button", { name: "Completed: check-54", exact: true })).toBeVisible();
  expect(requests.filter(name => name === "/step-details")).toHaveLength(50);
});

test("late completion updates an open operation without changing its disclosure or draft", async ({ page, history }) => {
  const progress = "Checking the current implementation and comparing its behavior with the reference. ".repeat(4) + "The final preview sentence stays readable.";
  history.add([event("assistant_text", { text: progress, phase: "progress", messageId: "live-progress" }),
    event("tool_call", { id: "live", name: "bash", command: "check-live", status: "in_progress" })]);
  await routes(page, history);
  await page.goto(`/#/task/${taskId}`);
  await expect.poll(() => page.evaluate(id => (window as unknown as Harness).hasScopedStream(id), taskId)).toBe(true);
  await send(page, taskId, { type: "tasks", tasks: [{ ...history.task, status: "running", updatedAt: Date.now(), lastActivityAt: Date.now() }], historyThrough: history.tasks.eventCursor(taskId) });
  const activity = page.locator("[data-activity]").getByRole("button").first();
  const preview = page.locator("[data-progress-preview]");
  await expect(preview).toBeVisible();
  await expect(activity).toBeVisible();
  await expect(preview).toContainText(progress);
  expect((await preview.boundingBox())!.height).toBeGreaterThan(24);
  await expect(page.getByText("Working…", { exact: true })).toHaveCount(0);
  await captureForReview(page, "trace-live-progress.png");
  await activity.click();
  const step = page.locator("[data-trace-step]").filter({ hasText: "check-live" });
  await expect(step).toHaveAccessibleName("Running: check-live");
  await step.click();
  const composer = page.locator("textarea").first(); await composer.fill("Keep this draft");
  history.add([event("tool_result", { tool_use_id: "live", output: "Live operation completed", exit_code: 0 }), event("result", {})]);
  await send(page, taskId, { type: "history-change", taskId, through: history.tasks.eventCursor(taskId) });
  await expect(step).toHaveAccessibleName("Completed: check-live");
  await expect(preview).toHaveCount(0);
  await expect(step).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Live operation completed", { exact: false })).toBeVisible();
  await expect(composer).toHaveValue("Keep this draft");
  await step.click();
  history.add([event("status", { subtype: "process_exit", code: 0 })]);
  await send(page, taskId, { type: "history-change", taskId, through: history.tasks.eventCursor(taskId) });
  await expect(step).toHaveAttribute("aria-expanded", "false");
});

test("execution records preserve lifecycle events without replacing the chat or draft", async ({ page, history }) => {
  history.add([event("status", { subtype: "turn_started" }), ...pair(0), event("result", {}), event("status", { subtype: "context_compacted" })]);
  const requests = await routes(page, history);
  await page.goto(`/#/task/${taskId}`);
  const composer = page.locator("textarea").first(); await composer.fill("Saved draft");
  expect(requests).not.toContain("/records");
  const menu = page.getByRole("button", { name: "Task actions", exact: true });
  await menu.click(); await page.getByRole("menuitem", { name: "Execution records", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Execution records", exact: true });
  await panel.getByRole("button", { name: "Record 5: status", exact: true }).click();
  await expect(panel.getByText('"subtype": "context_compacted"', { exact: false })).toBeVisible();
  expect(requests.filter(name => name === "/records")).toHaveLength(1);
  expect((await panel.boundingBox())!.width).toBe(360);
  await assertViewportLocked(page); await captureForReview(page, "trace-records-mobile.png");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden(); await expect(menu).toBeFocused(); await expect(composer).toHaveValue("Saved draft");
  await page.setViewportSize({ width: 1280, height: 900 });
  await menu.click(); await page.getByRole("menuitem", { name: "Execution records", exact: true }).click();
  await expect(panel).toBeVisible();
  expect((await panel.boundingBox())!.width).toBeLessThan(1280);
  await expect(panel.getByRole("button", { name: "Close", exact: true })).toBeInViewport();
  await captureForReview(page, "trace-records-desktop.png");
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(panel).toBeHidden(); await expect(menu).toBeFocused();
});


test("late classification preserves prose beside the open activity and operation", async ({ page, history }) => {
  history.add([event("assistant_text", { text: "Inspecting project", messageId: "progress" }), ...pair(0)]);
  await routes(page, history); await page.goto(`/#/task/${taskId}`);
  await page.getByRole("button", { name: "Activity · 1 tool", exact: true }).click();
  const step = page.getByRole("button", { name: "Completed: check-0", exact: true }); await step.click();
  await expect(page.getByText("Output for step 0", { exact: false })).toBeVisible();
  history.add([event("status", { subtype: "assistant_message", messageId: "progress", phase: "progress" })]);
  await send(page, taskId, { type: "history-change", taskId, through: history.tasks.eventCursor(taskId) });
  await expect(page.getByText("Inspecting project", { exact: true })).toBeVisible();
  await expect(step).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Output for step 0", { exact: false })).toBeVisible();
});

for (const phase of ["progress", "final", undefined] as const) test(`streaming placement stays stable with initial phase ${phase ?? "unknown"}`, async ({ page, history }) => {
  history.add([event("status", { subtype: "turn_started" }), event("tool_call", { id: "stream-tool", name: "bash", command: "stream-check", status: "in_progress" })]);
  await routes(page, history);
  await page.goto(`/#/task/${taskId}`);
  await expect.poll(() => page.evaluate(id => (window as unknown as Harness).hasScopedStream(id), taskId)).toBe(true);
  await send(page, taskId, { type: "tasks", tasks: [{ ...history.task, status: "running", updatedAt: Date.now() }], historyThrough: history.tasks.eventCursor(taskId) });
  const composer = page.locator("textarea").first(); await composer.fill("Keep the streaming draft");
  let text = "";
  for (const chunk of ["First streamed sentence. ", "Second streamed sentence."]) {
    text += chunk;
    history.add([event("assistant_text", { text: chunk, messageId: "stream-message", ...(phase ? { phase } : {}) })]);
    await send(page, taskId, { type: "history-change", taskId, through: history.tasks.eventCursor(taskId) });
    await expect(page.getByText(text.trim(), { exact: true })).toBeVisible();
    await expect(page.locator("[data-progress-preview]")).toHaveCount(phase === "progress" ? 1 : 0);
    await expect(composer).toHaveValue("Keep the streaming draft");
  }
  await captureForReview(page, `trace-phase-${phase ?? "unknown"}-streaming.png`);
  history.add([event("status", { subtype: "assistant_message", messageId: "stream-message", phase: phase ?? "progress" }),
    event("tool_result", { tool_use_id: "stream-tool", output: "Done", exit_code: 0 }), event("result", {})]);
  await send(page, taskId, { type: "history-change", taskId, through: history.tasks.eventCursor(taskId) });
  await expect(page.locator("[data-progress-preview]")).toHaveCount(0);
  if (phase !== "progress") await expect(page.getByText(text.trim(), { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("Keep the streaming draft");
  await captureForReview(page, `trace-phase-${phase ?? "unknown"}-completed.png`);
  await page.reload();
  if (phase !== "progress") await expect(page.getByText(text.trim(), { exact: true })).toBeVisible();
  else await expect(page.getByText(text.trim(), { exact: true })).toHaveCount(0);
});


test("collapsing nested output preserves its trigger position and keyboard focus", async ({ page, history }) => {
  history.add([...Array.from({ length: 12 }, (_, i) => pair(i)).flat(),
    event("tool_call", { id: "large", name: "bash", command: "long-output" }),
    event("tool_result", { tool_use_id: "large", output: "A line of output\n".repeat(100), exit_code: 0 }),
    event("assistant_text", { text: "Following answer paragraph.\n\n".repeat(30), phase: "final" })]);
  await routes(page, history); await page.goto(`/#/task/${taskId}`);
  const activity = page.getByRole("button", { name: "Activity · 13 tools", exact: true });
  await activity.click();
  const step = page.getByRole("button", { name: "Completed: long-output", exact: true });
  await step.click(); await expect(page.getByText("A line of output", { exact: false })).toBeVisible();
  await step.scrollIntoViewIfNeeded();
  await step.focus();
  const before = (await step.boundingBox())!.y;
  await page.keyboard.press("Enter");
  await expect(step).toHaveAttribute("aria-expanded", "false");
  await expect(step).toBeFocused();
  await expect.poll(async () => Math.abs((await step.boundingBox())!.y - before)).toBeLessThanOrEqual(2);
});
