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
  // Measure the next touch after the preceding slide finishes, otherwise its
  // coordinates can land on the moving menu button instead of the row surface.
  await target.evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true })
      .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {})));
  });
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
  await expect(target).toHaveAttribute("data-swipe-open", "");
  await expect(page).not.toHaveURL(/task\//);
  await expect(page.getByRole("status").filter({ hasText: "Refreshing…" })).toHaveCount(0);
  await assertViewportLocked(page);
  await captureForReview(page, "swipe-archive.png");
  await target.locator("button[data-swipe-surface]").click({ position: { x: 180, y: 25 } });
  await expect(archive).toHaveCount(0);
  await expect(page).not.toHaveURL(/task\//);
  await swipe(page, target, -135);
  await expect(archive).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(archive).toHaveCount(0);
  await swipe(page, target, -135);
  await expect(target).toHaveAttribute("data-swipe-open", "");
  await swipe(page, target, 130);
  await expect(archive).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // A regular tap still opens the session.
  await target.locator("button[data-swipe-surface]").click({ position: { x: 180, y: 25 } });
  await expect(page).toHaveURL(/task\/t-idle-rich/);
});

test("short, cancelled, and right swipes leave navigation and Archive closed", async ({ page }) => {
  const target = row(page);
  for (const [dx, cancel] of [[-25, false], [-130, true]] as const) {
    await swipe(page, target, dx, 0, cancel);
    await expect(target.getByRole("button", { name: "Archive", exact: true })).toHaveCount(0);
    await expect(page).not.toHaveURL(/task\//);
  }
  await swipe(page, target, 110);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).not.toHaveURL(/task\//);
});

test("vertical gestures scroll the list without revealing Archive", async ({ page }) => {
  await send(page, { type: "tasks", tasks: [idle, ...Array.from({ length: 24 }, (_, i) => ({ ...idle, taskId: `scroll-${i}`, title: `Scroll task ${i}` }))] });
  const target = row(page);
  const viewport = page.locator('[data-radix-scroll-area-viewport]').filter({ has: page.getByTestId("inbox-content") });
  await expect.poll(() => viewport.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(120);
  await swipe(page, target, -12, -120);
  await expect(page.getByRole("button", { name: "Archive", exact: true })).toHaveCount(0);
  await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBeGreaterThan(30);
  await assertViewportLocked(page);
});

test("Keep dismisses swipe archive without sending a destructive request", async ({ page }) => {
  let deletes = 0;
  await page.route(`**/api/tasks/${idle.taskId}`, route => {
    if (route.request().method() === "DELETE") deletes++;
    return route.fulfill({ json: { task: idle } });
  });
  await swipe(page, row(page), -130);
  await row(page).getByRole("button", { name: "Archive", exact: true }).tap();
  const dialog = page.getByRole("alertdialog", { name: "Archive this task?" });
  await expect(dialog).toContainText("deletes its git worktree");
  await dialog.getByRole("button", { name: "Keep" }).click();
  await expect(row(page).getByRole("button", { name: `Actions for ${idle.title}` })).toBeFocused();
  await expect(row(page)).toBeVisible();
  expect(deletes).toBe(0);
});

test("keyboard menu archive sends one request only after explicit confirmation", async ({ page }) => {
  let deletes = 0;
  await page.route(`**/api/tasks/${idle.taskId}`, route => {
    if (route.request().method() !== "DELETE") return route.fulfill({ json: { task: idle } });
    deletes++;
    return route.fulfill({ json: { task: { ...idle, status: "archived", updatedAt: idle.updatedAt + 1 } } });
  });
  const actions = row(page).getByRole("button", { name: `Actions for ${idle.title}` });
  const dialog = page.getByRole("alertdialog", { name: "Archive this task?" });
  const openArchive = async () => {
    await actions.press("Enter");
    await page.getByRole("menuitem", { name: "Archive", exact: true }).press("Enter");
    await expect(dialog.getByRole("button", { name: "Keep" })).toBeFocused();
  };
  await openArchive();
  await page.keyboard.press("Escape");
  await expect(actions).toBeFocused();
  await openArchive();
  expect(deletes).toBe(0);
  await dialog.getByRole("button", { name: "Archive task" }).press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(row(page)).toHaveCount(0);
  await expect(row(page, failed.taskId)).toBeVisible();
  expect(deletes).toBe(1);
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
