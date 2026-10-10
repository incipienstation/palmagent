import { test, expect, type Locator, type Page } from "@playwright/test";
import { tasks } from "../fixtures.mjs";
import { installInbox, send } from "./_inbox-stream";
import { assertViewportLocked, captureForReview } from "./_helpers";
import { taskTitle } from "../../src/lib/task-title";

test.use({ serviceWorkers: "block" });
const idle = tasks.find(task => task.taskId === "t-idle-rich")!;
const failed = tasks.find(task => task.taskId === "t-failed")!;
const running = tasks.find(task => task.taskId === "t-run")!;
const row = (page: Page, id = idle.taskId) => page.locator("[data-swipe-row]").filter({
  has: page.getByRole("button", { name: `Actions for ${taskTitle(tasks.find(task => task.taskId === id)!)}`, exact: true }),
});

async function swipe(page: Page, target: Locator, dx: number, dy = 0, cancel = false) {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  const x = box.x + (dx < 0 ? box.width - 70 : 35);
  const y = box.y + 25;
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let step = 1; step <= 8; step++) {
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx * step / 8, y: y + dy * step / 8 }] });
  }
  await session.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] });
  await session.detach();
}

test.beforeEach(async ({ page }) => {
  await installInbox(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  await send(page, { type: "tasks", tasks: [idle, failed] });
});

test("left swipe reveals Archive without navigating; body tap, Escape, and right swipe close it", async ({ page }) => {
  const target = row(page);
  const archive = target.getByRole("button", { name: "Archive", exact: true });
  await expect(archive).toHaveCount(0);
  await swipe(page, target, -135, 15);
  await expect(archive).toBeVisible();
  await expect(page).not.toHaveURL(/task\//);
  await expect(page.getByRole("status").filter({ hasText: "Refreshing…" })).toHaveCount(0);
  await assertViewportLocked(page);
  await captureForReview(page, "swipe-archive.png");
  await target.locator("button[data-swipe-surface]").click({ position: { x: 180, y: 25 } });
  await expect(archive).toHaveCount(0);
  await expect(page).not.toHaveURL(/task\//);
  await swipe(page, target, -135);
  await page.keyboard.press("Escape");
  await expect(archive).toHaveCount(0);
  await swipe(page, target, -135);
  await swipe(page, target, 130);
  await expect(archive).toHaveCount(0);
  // A regular tap still opens the session.
  await target.locator("button[data-swipe-surface]").click({ position: { x: 180, y: 25 } });
  await expect(page).toHaveURL(/task\/t-idle-rich/);
});

test("short, rightward, and cancelled gestures leave Archive hidden", async ({ page }) => {
  const target = row(page);
  for (const [dx, cancel] of [[-25, false], [110, false], [-130, true]] as const) {
    await swipe(page, target, dx, 0, cancel);
    await expect(target.getByRole("button", { name: "Archive", exact: true })).toHaveCount(0);
    await expect(page).not.toHaveURL(/task\//);
  }
});

test("vertical gestures scroll the list without revealing Archive", async ({ page }) => {
  await send(page, { type: "tasks", tasks: [idle, ...Array.from({ length: 10 }, (_, i) => ({ ...idle, taskId: `scroll-${i}`, title: `Scroll task ${i}` }))] });
  const target = row(page);
  await swipe(page, target, -12, -120);
  await expect(page.getByRole("button", { name: "Archive", exact: true })).toHaveCount(0);
  const viewport = page.locator('[data-radix-scroll-area-viewport]').filter({ has: page.getByTestId("inbox-content") });
  await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBeGreaterThan(30);
  await assertViewportLocked(page);
});

test("swipe archive can be undone before any destructive request", async ({ page }) => {
  let deletes = 0;
  await page.route(`**/api/tasks/${idle.taskId}`, route => {
    if (route.request().method() === "DELETE") deletes++;
    return route.fulfill({ json: { task: idle } });
  });
  await swipe(page, row(page), -130);
  await row(page).getByRole("button", { name: "Archive", exact: true }).tap();
  await expect(row(page)).toHaveCount(0);
  await expect(page.getByTestId("toast")).toContainText("worktree");
  expect(deletes).toBe(0);
  await page.locator('[data-testid="toast"][data-removed="false"]').getByRole("button", { name: "Undo", exact: true }).click();
  await expect(row(page)).toBeVisible();
  expect(deletes).toBe(0);
});

test("menu archive supports keyboard access and Undo restores a batch", async ({ page }) => {
  for (const task of [idle, failed]) {
    await row(page, task.taskId).getByRole("button", { name: `Actions for ${taskTitle(task)}`, exact: true }).click();
    const archive = page.getByRole("menuitem", { name: "Archive", exact: true });
    await archive.focus();
    await page.keyboard.press("Enter");
    await expect(row(page, task.taskId)).toHaveCount(0);
  }
  await expect(page.getByTestId("toast").filter({ hasText: "2 tasks ready to archive" })).toBeVisible();
  await page.locator('[data-testid="toast"][data-removed="false"]').getByRole("button", { name: "Undo", exact: true }).click();
  await expect(row(page)).toBeVisible();
  await expect(row(page, failed.taskId)).toBeVisible();
});

test("dismissing Undo cancels the pending archive instead of committing early", async ({ page }) => {
  await page.clock.install();
  let deletes = 0;
  await page.route(`**/api/tasks/${idle.taskId}`, route => {
    if (route.request().method() === "DELETE") deletes++;
    return route.fulfill({ json: { task: idle } });
  });
  await row(page).getByRole("button", { name: `Actions for ${idle.title}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await page.locator('[data-testid="toast"][data-removed="false"]').getByRole("button", { name: "Undo", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(row(page)).toBeVisible();
  await page.clock.runFor(9000);
  expect(deletes).toBe(0);
});

for (const succeeds of [true, false]) test(`archive waits for Undo to expire and ${succeeds ? "commits once" : "restores the row on failure"}`, async ({ page }) => {
  await page.clock.install();
  let deletes = 0;
  await page.route(`**/api/tasks/${idle.taskId}`, route => {
    if (route.request().method() !== "DELETE") return route.fulfill({ json: { task: idle } });
    deletes++;
    return succeeds
      ? route.fulfill({ json: { task: { ...idle, status: "archived", updatedAt: idle.updatedAt + 1 } } })
      : route.fulfill({ status: 503, json: { error: "Archive unavailable" } });
  });
  await row(page).getByRole("button", { name: `Actions for ${idle.title}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await expect(row(page)).toHaveCount(0);
  await expect(page.locator('[data-testid="toast"][data-removed="false"]').getByRole("button", { name: "Undo", exact: true })).toBeVisible();
  await page.mouse.move(0, 0);
  await page.clock.runFor(7000);
  expect(deletes).toBe(0);
  // Route changes must not abandon the pending archive.
  await page.evaluate(() => { location.hash = "/spaces"; });
  await page.clock.runFor(2000);
  await expect.poll(() => deletes).toBe(1);
  await page.evaluate(() => { location.hash = "/"; });
  if (succeeds) await expect(row(page)).toHaveCount(0);
  else {
    await expect(row(page)).toBeVisible();
    await expect(page.getByTestId("toast")).toContainText("Couldn't archive this task");
  }
});

test("active and locally owned tasks cannot be archived from the list", async ({ page }) => {
  for (const task of [running, { ...idle, sessionControl: {
    owner: "local" as const, home: "/sessions", transcript: "/sessions/local.jsonl", cursor: 0, prefixHash: "",
  } }]) {
    await send(page, { type: "tasks", tasks: [task] });
    const target = row(page, task.taskId);
    await swipe(page, target, -130);
    await expect(target.getByRole("button", { name: "Archive", exact: true })).toHaveCount(0);
    await target.getByRole("button", { name: `Actions for ${taskTitle(task)}`, exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Archive", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
  }
});
