import { test, expect } from "@playwright/test";
import { assertViewportLocked, captureForReview } from "./_helpers";

test.use({ serviceWorkers: "block" });

test("short filter sheets align content and actions above the safe area", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto("/");
  await page.evaluate(() => document.documentElement.style.setProperty("--safe-bottom", "34px"));
  const trigger = page.getByRole("button", { name: "Filters", exact: true });
  await trigger.click();
  const sheet = page.getByRole("dialog", { name: "Task filters" });
  const title = sheet.getByRole("heading", { name: "Task filters" });
  const status = sheet.getByRole("combobox", { name: "Status" });
  const done = sheet.getByRole("button", { name: "Done", exact: true });
  await expect(done).toBeInViewport({ ratio: 1 });
  const [heading, field, action] = await Promise.all([title, status, done].map(el => el.boundingBox()));
  expect(field!.x).toBeCloseTo(heading!.x, 0);
  expect(action!.x).toBeCloseTo(field!.x, 0);
  expect(action!.width).toBeCloseTo(field!.width, 0);
  expect(action!.height).toBeGreaterThanOrEqual(44);
  expect(action!.y + action!.height).toBeLessThanOrEqual(780 - 34);
  expect(await sheet.locator('[data-slot="drawer-body"]').evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  await captureForReview(page, "bottom-sheet-filters-dark.png");
  await status.click();
  await page.getByRole("option", { name: "Working", exact: true }).click();
  await done.click();
  await expect(sheet).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.getByRole("button", { name: "Clear status filter" })).toContainText("Working");
  await assertViewportLocked(page);
});

test("long supporting sheets scroll their body while the title stays visible", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.route("**/api/tasks/t-run-charts/account-limits", route => route.fulfill({ json: {
    agent: "codex", state: "ready", checkedAt: Date.now(),
    buckets: Array.from({ length: 20 }, (_, index) => ({
      id: `bucket-${index}`, name: `Allowance ${index + 1}`,
      primary: { usedPercent: 25, windowMinutes: 300, resetsAt: null },
    })),
  } }));
  await page.goto("/#/task/t-run-charts");
  await page.getByRole("button", { name: "Account limit details" }).click();
  const sheet = page.getByRole("dialog", { name: "Codex account limits" });
  const title = sheet.getByRole("heading", { name: "Codex account limits" });
  await expect(title).toBeInViewport({ ratio: 1 });
  // Wait for the drawer's opening transition before comparing positions.
  await sheet.evaluate(async el => {
    await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
  });
  const top = (await title.boundingBox())!.y;
  await sheet.getByRole("heading", { name: "Allowance 20", exact: true }).scrollIntoViewIfNeeded();
  await expect(sheet.getByRole("heading", { name: "Allowance 20", exact: true })).toBeInViewport({ ratio: 1 });
  await expect(title).toBeInViewport({ ratio: 1 });
  expect((await title.boundingBox())!.y).toBeCloseTo(top, 0);
  expect(await sheet.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await captureForReview(page, "bottom-sheet-long-content.png");
  await assertViewportLocked(page);
});

test("Configure keeps its action reachable while content scrolls in a reduced viewport", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 400 });
  await page.goto("/#/new/space/repo-app");
  await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("Keep this draft");
  await page.getByRole("button", { name: "Configure task settings" }).click();
  const sheet = page.getByRole("dialog", { name: "Configure", exact: true });
  const done = sheet.getByRole("button", { name: "Done", exact: true });
  await expect(done).toBeInViewport({ ratio: 1 });
  await sheet.evaluate(async el => {
    await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
  });
  const top = (await done.boundingBox())!.y;
  await sheet.locator('[data-slot="settings-scroll"]').evaluate(el => { el.scrollTop = el.scrollHeight; });
  expect((await done.boundingBox())!.y).toBeCloseTo(top, 0);
  await expect(sheet.getByRole("heading", { name: "Configure", exact: true })).toBeInViewport({ ratio: 1 });
  await captureForReview(page, "bottom-sheet-configure-small.png");
  await done.click();
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("Keep this draft");
  await assertViewportLocked(page);
});

test("bottom sheets stay centered on desktop and dismiss with a touch drag on mobile", async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?__theme=light");
  const trigger = page.getByRole("button", { name: "Filters", exact: true });
  await trigger.click();
  const sheet = page.getByRole("dialog", { name: "Task filters" });
  await expect(sheet.getByRole("heading", { name: "Task filters" })).toBeInViewport({ ratio: 1 });
  const box = (await sheet.boundingBox())!;
  expect(box.width).toBeLessThan(1280);
  expect(box.x).toBeCloseTo((1280 - box.width) / 2, 0);
  await captureForReview(page, "bottom-sheet-desktop-light.png");
  await sheet.getByRole("button", { name: "Done", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await page.setViewportSize({ width: 360, height: 780 });
  await trigger.click();
  await sheet.evaluate(async el => {
    await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
  });
  const title = (await sheet.getByRole("heading", { name: "Task filters" }).boundingBox())!;
  const point = { x: title.x + 30, y: title.y + title.height / 2, id: 0 };
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  for (const distance of [10, 30, 60, 90, 130, 170]) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, y: point.y + distance }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await expect(sheet).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await assertViewportLocked(page);
});

test("Add Space keeps selection fields and its action reachable with a short viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 400 });
  await page.goto("/#/new/space/repo-app");
  await page.getByRole("combobox", { name: "Space" }).click();
  await page.getByRole("option", { name: "Add Space", exact: true }).click();
  await page.getByRole("option", { name: "Browse folders…" }).click();
  await page.getByRole("button", { name: "Choose outer-repo as Space" }).click();
  const sheet = page.getByRole("dialog", { name: "Add Space", exact: true });
  const connect = sheet.getByRole("button", { name: "Connect Space", exact: true });
  await expect(connect).toBeInViewport({ ratio: 1 });
  await sheet.getByLabel("Base branch (optional)").fill("develop");
  await expect(connect).toBeInViewport({ ratio: 1 });
  await captureForReview(page, "bottom-sheet-add-space-small.png");
  await assertViewportLocked(page);
});
