import { test, expect, type Locator } from "@playwright/test";
import { assertViewportLocked, captureForReview } from "./_helpers";

test.use({ serviceWorkers: "block" });
async function settled(dialog: Locator) {
  await expect(dialog).toBeVisible();
  await dialog.evaluate(async el => {
    await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
  });
}

for (const width of [360, 1280]) {
  test(`dialog action pairs share their layout at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 780 });
    await page.goto("/#/task/t-idle-rich");
    const trigger = page.getByRole("button", { name: "Task actions", exact: true });
    for (const [menu, role, cancel, action] of [
      ["Archive", "alertdialog", "Keep", "Archive task"],
      ["Rename", "dialog", "Cancel", "Save"],
    ] as const) {
      await trigger.click();
      await page.getByRole("menuitem", { name: menu, exact: true }).click();
      const dialog = page.getByRole(role);
      await settled(dialog);
      const secondary = dialog.getByRole("button", { name: cancel, exact: true });
      const primary = dialog.getByRole("button", { name: action, exact: true });
      const [a, b] = await Promise.all([secondary.boundingBox(), primary.boundingBox()]);
      if (width < 640) {
        expect(b!.y + b!.height).toBeLessThan(a!.y);
        expect(a!.width).toBeCloseTo(b!.width, 0);
        expect(a!.width).toBeGreaterThan(280);
      } else {
        expect(a!.y).toBeCloseTo(b!.y, 0);
        expect(a!.x + a!.width).toBeLessThan(b!.x);
      }
      await expect(secondary).toBeInViewport({ ratio: 1 });
      await expect(primary).toBeInViewport({ ratio: 1 });
      if (role === "alertdialog") await expect(secondary).toBeFocused();
      await captureForReview(page, `dialog-${menu.toLowerCase()}-${width}.png`);
      await secondary.click();
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
    await page.goto("/#/task/t-run-charts");
    await trigger.click();
    await page.getByRole("menuitem", { name: "Cancel…", exact: true }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm.getByRole("button", { name: "Keep", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await assertViewportLocked(page);
  });
}

test("Settings stays centered, preserves scroll across resizing, and restores nested confirmation focus", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 780 });
  await page.goto("/?__theme=light");
  const trigger = page.getByRole("button", { name: "Settings", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await settled(dialog);
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeCloseTo((1280 - bounds.width) / 2, 0);
  expect(bounds.y).toBeCloseTo((780 - bounds.height) / 2, 0);
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
  await page.setViewportSize({ width: 360, height: 780 });
  await settled(dialog);
  await expect(dialog.locator('[data-slot="drawer-handle"]')).toBeVisible();
  expect(await viewport.evaluate(el => el.scrollTop)).toBeCloseTo(scroll, 0);
  await page.setViewportSize({ width: 1280, height: 780 });
  await settled(dialog);
  expect(await viewport.evaluate(el => el.scrollTop)).toBeCloseTo(scroll, 0);
  const signOut = dialog.getByRole("button", { name: "Sign out", exact: true });
  await signOut.click();
  const alert = page.getByRole("alertdialog");
  await expect(alert).toBeVisible();
  await expect(alert.getByRole("button", { name: "Stay", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(alert).toHaveCount(0);
  await expect(signOut).toBeFocused();
  await dialog.getByRole("button", { name: "Close settings" }).click();
  await expect(trigger).toBeFocused();
  await assertViewportLocked(page);
});

test("Add Space preserves a focused field and its draft through responsive layout changes", async ({ page }) => {
  await page.goto("/#/new/space/repo-app");
  await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("Keep the surrounding composer draft");
  await page.getByRole("combobox", { name: "Space", exact: true }).click();
  await page.getByRole("option", { name: "Add Space", exact: true }).click();
  await page.getByRole("option", { name: "Browse folders…" }).click();
  await page.getByRole("button", { name: "Choose outer-repo as Space" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Space", exact: true });
  const field = dialog.getByLabel("Base branch (optional)");
  await field.fill("draft-branch");
  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 780 });
    await settled(dialog);
    await expect(field).toHaveValue("draft-branch");
    await expect(field).toBeFocused();
    await expect(dialog.getByRole("button", { name: "Connect Space", exact: true })).toBeInViewport({ ratio: 1 });
  }
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("Keep the surrounding composer draft");
  await assertViewportLocked(page);
});
