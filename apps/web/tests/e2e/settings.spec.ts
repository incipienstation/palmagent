import { test, expect, type Page } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";

test.use({ serviceWorkers: "block" });

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

for (const [name, width, height] of [
  ["mobile", 360, 780],
  ["desktop", 1280, 900],
] as const) {
  test(`settings sections fit the ${name} viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    const settings = await openSettings(page);
    await expect(settings.getByRole("region", { name: "On this device" })).toBeVisible();
    await expect(settings.getByRole("region", { name: "Installation" })).toBeVisible();
    await assertViewportLocked(page);
    expect(await settings.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  });
}

test("preferences persist, cannot be deselected, and sign out remains cancellable", async ({ page }) => {
  await page.goto("/");
  await openSettings(page);
  const light = page.getByRole("radio", { name: "Light theme" });
  await light.click();
  await light.click();
  await expect(light).toBeChecked();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  const verbose = page.getByRole("radio", { name: "Verbose output" });
  await verbose.click();
  await verbose.click();
  await expect(verbose).toBeChecked();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Stay" }).click();
  await expect(confirm).toHaveCount(0);
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await openSettings(page);
  await expect(light).toBeChecked();
  await expect(verbose).toBeChecked();
});

test("keyboard navigation returns focus and keeps narrow settings within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");
  await openSettings(page);
  const spaces = page.getByRole("button", { name: "Spaces", exact: true });
  await spaces.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Spaces", exact: true })).toBeFocused();
  const input = page.getByRole("textbox", { name: "Add search folder" });
  await input.fill("/projects/draft");
  await page.getByRole("button", { name: "Back to settings" }).focus();
  await page.keyboard.press("Enter");
  await expect(spaces).toBeFocused();
  const scroll = page.locator('[data-slot="settings-scroll"]:visible');
  expect(await scroll.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await spaces.click();
  await expect(input).toHaveValue("/projects/draft");
  await assertViewportLocked(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toBeFocused();
});
