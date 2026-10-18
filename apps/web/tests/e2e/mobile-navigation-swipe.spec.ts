import { test, expect, type Page } from "@playwright/test";
import { tasks } from "../fixtures.mjs";
import { installInbox, send } from "./_inbox-stream";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const idle = tasks.find(task => task.taskId === "t-idle-rich")!;

async function swipe(page: Page, x: number, y: number, dx: number, dy = 0, cancel = false, hold = 0) {
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let step = 1; step <= 8; step++) {
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx * step / 8, y: y + dy * step / 8 }] });
  }
  if (hold) await page.waitForTimeout(hold);
  await session.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] });
  await session.detach();
}

test.beforeEach(async ({ page }) => {
  await installInbox(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  await send(page, { type: "tasks", tasks: [idle] });
});

test("a right swipe opens navigation only from the left edge", async ({ page }) => {
  const row = page.locator("[data-swipe-row]").first();
  const bounds = (await row.boundingBox())!;
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  expect(x).toBeGreaterThan(80);
  await swipe(page, x, y, 120);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await swipe(page, 8, y, 220);
  await expect(page.getByRole("dialog", { name: "Palmagent", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();
});

test("vertical, short, and cancelled swipes leave navigation closed", async ({ page }) => {
  const row = page.locator("[data-swipe-row]").first();
  const bounds = (await row.boundingBox())!;
  const x = 8;
  const y = bounds.y + bounds.height / 2;
  for (const [dx, dy, cancel] of [[0, 130, false], [32, 0, false], [120, 0, true]] as const) {
    await swipe(page, x, y, dx, dy, cancel, 300);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
});

test("nested modal surfaces keep the edge disabled until the last surface closes", async ({ page }) => {
  const edge = page.getByTestId("navigation-swipe-area");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  await expect(edge).toHaveAttribute("data-disabled", "");
  await settings.getByRole("button", { name: "Sign out", exact: true }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  await swipe(page, 8, 400, 220);
  await expect(page.locator('[data-side="left"][data-slot="drawer-content"]')).toHaveCount(0);
  await confirm.getByRole("button", { name: "Stay" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(edge).toHaveAttribute("data-disabled", "");
  await settings.getByRole("button", { name: "Close settings" }).click();
  await expect(settings).toHaveCount(0);
  await expect(edge).not.toHaveAttribute("data-disabled");
  await swipe(page, 8, 400, 220);
  await expect(page.getByRole("dialog", { name: "Palmagent", exact: true })).toBeVisible();
});
