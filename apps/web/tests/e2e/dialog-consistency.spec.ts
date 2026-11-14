import { test, expect, type Locator } from "@playwright/test";
import { assertViewportLocked, captureForReview } from "./_helpers";

test.use({ serviceWorkers: "block" });
async function settled(dialog: Locator) {
  await expect(dialog).toBeVisible();
  await dialog.evaluate(async el => {
    await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
  });
}

test("Settings stays centered, preserves scroll across resizing, and restores nested confirmation focus", async ({ page }) => {
  // Keep this viewport short enough to exercise scroll restoration with compact settings.
  await page.setViewportSize({ width: 1280, height: 568 });
  await page.goto("/?__theme=light");
  const trigger = page.getByRole("button", { name: "Settings", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await settled(dialog);
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeCloseTo((1280 - bounds.width) / 2, 0);
  expect(bounds.y).toBeCloseTo((568 - bounds.height) / 2, 0);
  await expect(dialog.locator('[data-slot="drawer-handle"]')).toBeHidden();
  // Dragging a desktop title must not move or dismiss the dialog.
  const title = dialog.getByRole("heading", { name: "Settings", exact: true });
  const heading = (await title.boundingBox())!;
  await page.mouse.move(heading.x + 20, heading.y + 10);
  await page.mouse.down(); await page.mouse.move(heading.x + 20, heading.y + 200, { steps: 10 }); await page.mouse.up();
  expect((await dialog.boundingBox())!.y).toBeCloseTo(bounds.y, 0);
  const viewport = dialog.locator('[data-slot="settings-scroll"]:visible [data-radix-scroll-area-viewport]');
  await viewport.evaluate(el => { el.scrollTop = 100; });
  const scroll = await viewport.evaluate(el => el.scrollTop);
  expect(scroll).toBeGreaterThan(0);
  await captureForReview(page, "dialog-settings-desktop.png");
  await page.setViewportSize({ width: 360, height: 568 });
  await settled(dialog);
  await expect(dialog.locator('[data-slot="drawer-handle"]')).toBeVisible();
  expect(await viewport.evaluate(el => el.scrollTop)).toBeCloseTo(scroll, 0);
  await page.setViewportSize({ width: 1280, height: 568 });
  await settled(dialog);
  expect(await viewport.evaluate(el => el.scrollTop)).toBeCloseTo(scroll, 0);
  const signOut = dialog.getByRole("button", { name: "Sign out", exact: true });
  await signOut.click();
  const alert = page.getByRole("alertdialog");
  await settled(alert);
  await expect(alert.getByRole("button", { name: "Stay", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(alert).toHaveCount(0);
  await expect(signOut).toBeFocused();
  await dialog.getByRole("button", { name: "Close settings" }).click();
  await expect(trigger).toBeFocused();
  await assertViewportLocked(page);
});
