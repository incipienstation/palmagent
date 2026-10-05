import { test, expect, type Page } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";

test.use({ serviceWorkers: "block" });

async function openSettings(page: Page) {
  if ((page.viewportSize()?.width ?? 360) < 768) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("an existing update checkpoint restores native settings scroll into the new viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 400 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "All spaces", exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const id = "settings-scroll-upgrade";
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("palmagent-screen-state", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("checkpoints");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction("checkpoints", "readwrite");
        // Previous clients recorded the inbox followed by four native settings panes.
        transaction.objectStore("checkpoints").put({ route: location.hash, created: Date.now(),
          values: { "settings:open": true, "settings:section": "general" },
          screen: { scroll: [0, 120, 0, 0, 0].map(top => ({ top, left: 0 })) } }, id);
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => { db.close(); reject(transaction.error); };
      };
    });
    sessionStorage.setItem("palmagent:screen-checkpoint", id);
  });
  await page.reload();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  const viewport = settings.locator('[data-slot="settings-scroll"]:visible [data-radix-scroll-area-viewport]');
  await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBe(120);
  await assertViewportLocked(page);
});

test("settings sections fit the desktop viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  const settings = await openSettings(page);
  await expect(settings.getByRole("region", { name: "On this device" })).toBeVisible();
  await expect(settings.getByRole("region", { name: "Installation" })).toBeVisible();
  await assertViewportLocked(page);
  expect(await settings.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
});

test("mobile settings fit, preserve preferences, and keep sign-out cancellable", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto("/");
  const settings = await openSettings(page);
  await expect(settings.getByRole("region", { name: "On this device" })).toBeVisible();
  await expect(settings.getByRole("region", { name: "Installation" })).toBeVisible();
  await assertViewportLocked(page);
  expect(await settings.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
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
  const spaces = page.getByRole("button", { name: "Repository search paths", exact: true });
  await spaces.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Repository search paths", exact: true, level: 2 })).toBeFocused();
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
