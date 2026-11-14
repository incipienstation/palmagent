import { test, expect } from "@playwright/test";
import { assertViewportLocked, captureForReview } from "./_helpers";

test.use({ serviceWorkers: "block" });

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
  await sheet.locator('[data-slot="settings-scroll"] [data-radix-scroll-area-viewport]').evaluate(el => { el.scrollTop = el.scrollHeight; });
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
  const trigger = page.getByRole("button", { name: /^Filters(?:,|$)/ });
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
