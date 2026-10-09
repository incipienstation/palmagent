import { test, expect, type Page } from "@playwright/test";
import type { TaskState } from "@palmagent/shared";
import { tasks } from "../fixtures.mjs";
import { installScopedStream, open, send, type Harness } from "./_scoped-stream";
import { assertViewportLocked } from "./_helpers";

test.use({ serviceWorkers: "block" });
async function setup(page: Page, patch: Partial<TaskState> = {}) {
  await installScopedStream(page);
  const task: TaskState = { ...tasks.find(t => t.taskId === "t-idle-rich")!, agent: "codex", model: undefined,
    contextUsage: { usedTokens: 84000, windowTokens: 200000, updatedAt: Date.now() },
    messageQueue: { revision: 1, paused: false, runId: null, messages: [] }, ...patch };
  const requests: unknown[] = [];
  await page.route(`**/api/tasks/${task.taskId}`, route => route.fulfill({ json: { task } }));
  await page.route(`**/api/tasks/${task.taskId}/account-limits`, route => route.fulfill({ json: {
    agent: task.agent, state: "ready", checkedAt: Date.now(), buckets: [{ id: "codex", name: "Codex",
      primary: { usedPercent: 22, windowMinutes: 300, resetsAt: Date.now() + 3600000 },
      secondary: { usedPercent: 8, windowMinutes: 10080, resetsAt: Date.now() + 86400000 } }], modelLimits: [],
  } }));
  await page.route(`**/api/tasks/${task.taskId}/compact`, route => {
    const request = route.request().postDataJSON(); requests.push(request);
    task.status = "running";
    task.contextUsage = { ...task.contextUsage!, stale: true };
    task.messageQueue = { ...task.messageQueue!, revision: 2, runId: "compact-run", compaction: { requestId: request.requestId, status: "running" } };
    return route.fulfill({ status: 202, json: { task } });
  });
  const snapshot = async () => {
    await expect.poll(() => page.evaluate(id => (window as unknown as Harness).hasScopedStream(id), task.taskId)).toBe(true);
    await send(page, task.taskId, { type: "tasks", tasks: [task], historyThrough: 0 });
  };
  await open(page, task.taskId); await snapshot();
  return { task, snapshot, requests, line: page.getByRole("region", { name: "Session usage" }) };
}

for (const width of [320, 1280]) test(`context circle shows remaining capacity and preserves the compact layout at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 780 });
  const f = await setup(page);
  const context = f.line.getByLabel("Context 58% left", { exact: true });
  await expect(context).toBeVisible();
  const arc = context.locator("circle[pathLength]");
  expect(Number((await arc.getAttribute("stroke-dasharray"))!.split(" ")[0])).toBeCloseTo(58);
  await expect(f.line.getByText("78%", { exact: true })).toBeVisible();
  await expect(f.line.getByText("92%", { exact: true })).toBeVisible();
  const trigger = f.line.getByRole("button", { name: "Usage details" });
  expect((await trigger.boundingBox())!.height).toBe(40);
  expect(await f.line.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Keep this draft");
  await trigger.focus(); await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog", { name: "Session usage" });
  await expect(sheet.getByText("84,000 / 200,000 tokens used")).toBeVisible();
  await expect(sheet.getByText("58% context remaining")).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Codex account limits" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(draft).toHaveValue("Keep this draft");
  await assertViewportLocked(page);
});

test("live context updates, reconnect snapshots and reload do not need usage events in the visible history", async ({ page }) => {
  const f = await setup(page);
  await expect(f.line.getByText("58% left", { exact: true })).toBeVisible();
  f.task.contextUsage = { usedTokens: 160000, windowTokens: 200000, updatedAt: Date.now() };
  await f.snapshot();
  await expect(f.line.getByText("20% left", { exact: true })).toBeVisible();
  await page.reload(); await f.snapshot();
  await expect(f.line.getByText("20% left", { exact: true })).toBeVisible();
  f.task.contextUsage = { ...f.task.contextUsage, stale: true }; await f.snapshot();
  await expect(f.line.getByLabel("Context —", { exact: true })).toBeVisible();
  await expect(f.line.getByLabel("Context —", { exact: true }).locator("svg")).toHaveCount(0);
  await f.line.getByRole("button", { name: "Usage details" }).click();
  await expect(page.getByRole("dialog").getByText("Waiting for an updated context reading.")).toBeVisible();
  await expect(page.getByRole("dialog").getByText("Last reading: 160,000 / 200,000 tokens used")).toBeVisible();
  f.task.contextUsage = { usedTokens: 10000, windowTokens: 200000, updatedAt: Date.now() }; await f.snapshot();
  await expect(page.getByRole("dialog").getByText("95% context remaining")).toBeVisible();
});

test("unknown capacity and failed account reads stay independent without invented percentages", async ({ page }) => {
  const f = await setup(page, { contextUsage: { usedTokens: 12000, windowTokens: null, updatedAt: Date.now() } });
  await expect(f.line.getByLabel("Context —", { exact: true })).toBeVisible();
  await f.line.getByRole("button", { name: "Usage details" }).click();
  await expect(page.getByRole("dialog").getByText("12,000 / unknown tokens used")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.route(`**/api/tasks/${f.task.taskId}/account-limits`, route => route.fulfill({ status: 503, json: { error: "offline" } }));
  f.task.contextUsage = { usedTokens: 84000, windowTokens: 200000, updatedAt: Date.now() };
  await page.reload(); await f.snapshot();
  await expect(f.line.getByText("Limits unavailable")).toBeVisible();
  await expect(f.line.getByText("58% left", { exact: true })).toBeVisible();
  f.task.contextUsage = undefined; await f.snapshot();
  await expect(f.line.getByLabel("Context —", { exact: true })).toBeVisible();
});

test("Compact from usage details reuses confirmation, restores focus, and waits for a new reading", async ({ page }) => {
  const f = await setup(page);
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Preserve my draft");
  const trigger = f.line.getByRole("button", { name: "Usage details" });
  await trigger.click();
  await page.getByRole("dialog").getByRole("button", { name: "Compact context", exact: true }).click();
  const intro = page.getByRole("alertdialog", { name: "Compact context?" });
  await expect(intro).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await intro.getByRole("button", { name: "Not now" }).click();
  await expect(trigger).toBeFocused();
  expect(f.requests).toHaveLength(0);
  await trigger.click();
  await page.getByRole("dialog").getByRole("button", { name: "Compact context", exact: true }).click();
  await intro.getByRole("button", { name: "Compact context", exact: true }).click();
  await expect.poll(() => f.requests.length).toBe(1); await f.snapshot();
  await expect(f.line.getByLabel("Context Compacting…", { exact: true })).toBeVisible();
  await trigger.click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Compact context", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  f.task.status = "idle";
  f.task.messageQueue = { ...f.task.messageQueue!, revision: 3, runId: null, compaction: { ...f.task.messageQueue!.compaction!, status: "completed" } };
  await f.snapshot();
  await expect(f.line.getByLabel("Context —", { exact: true })).toBeVisible();
  f.task.contextUsage = { usedTokens: 20000, windowTokens: 200000, updatedAt: Date.now() }; await f.snapshot();
  await expect(f.line.getByText("90% left", { exact: true })).toBeVisible();
  await expect(draft).toHaveValue("Preserve my draft");
  await assertViewportLocked(page);
});
