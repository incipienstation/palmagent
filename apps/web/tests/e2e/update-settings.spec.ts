import { test, expect, type Page } from "@playwright/test";
import type { UpdateSettingsStatus } from "@palmagent/shared";
import { updateSettings } from "../fixtures.mjs";
import { assertViewportLocked } from "./_helpers";

// Page route fixtures must not be bypassed by a service worker's own requests.
test.use({ serviceWorkers: "block" });

async function openSettings(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Updates", exact: true })).toBeVisible();
}

test("settings show the running version, save shared preferences, and remain usable on a small screen", async ({ page }) => {
  let state = structuredClone(updateSettings) as UpdateSettingsStatus;
  const changes: unknown[] = [];
  await page.route("**/api/settings/updates", async (route) => {
    if (route.request().method() === "PATCH") {
      const change = route.request().postDataJSON(); changes.push(change);
      state = { ...state, settings: { ...state.settings!, ...change, timerActive: change.autoUpdate ?? state.settings!.timerActive } };
    }
    await route.fulfill({ json: state });
  });
  await openSettings(page);
  await expect(page.getByTestId("current-version")).toHaveText("0.1.0-alpha.4");
  await expect(page).toHaveScreenshot("update-settings.png");
  const automatic = page.getByRole("switch", { name: "Automatic updates" });
  await expect(automatic).not.toBeChecked();
  await automatic.click();
  await expect(automatic).toBeChecked();
  await expect(automatic).toBeEnabled();
  await page.getByRole("radio", { name: "Stable", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Stable", exact: true })).toBeChecked();
  expect(changes).toEqual([{ autoUpdate: true }, { channel: "stable" }]);
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(automatic).toBeChecked();
  await expect(page.getByTestId("current-version")).toHaveText("0.1.0-alpha.4");
  await expect(page.getByRole("radio", { name: "Stable", exact: true })).toBeChecked();
  await assertViewportLocked(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await assertViewportLocked(page);
});

test("a failed save reconciles the actual setting rather than showing a false rollback", async ({ page }) => {
  const state = structuredClone(updateSettings) as UpdateSettingsStatus;
  let reads = 0;
  await page.route("**/api/settings/updates", async (route) => {
    if (route.request().method() === "PATCH") {
      state.settings!.autoUpdate = true;
      state.settings!.timerActive = true;
      return route.fulfill({ status: 503, json: { error: "Could not confirm the update setting. Refresh its status before trying again." } });
    }
    reads++;
    await route.fulfill({ json: state });
  });
  await openSettings(page);
  const automatic = page.getByRole("switch", { name: "Automatic updates" });
  await automatic.click();
  await expect(page.getByRole("alert")).toContainText("Could not confirm");
  await expect(automatic).toBeChecked();
  await expect(automatic).toBeEnabled();
  expect(reads).toBe(2);
});

test("pending saves disable both controls and do not change the displayed running version", async ({ page }) => {
  let finish: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  await page.route("**/api/settings/updates", async (route) => {
    if (route.request().method() === "PATCH") await waiting;
    await route.fulfill({ json: updateSettings });
  });
  await openSettings(page);
  const automatic = page.getByRole("switch", { name: "Automatic updates" });
  await automatic.click();
  await expect(automatic).toBeDisabled();
  await expect(page.getByRole("radio", { name: "Stable", exact: true })).toBeDisabled();
  await expect(page.getByTestId("current-version")).toHaveText("0.1.0-alpha.4");
  finish!();
  await expect(automatic).toBeEnabled();
});

test("unavailable management keeps the current version visible and explains the required setup", async ({ page }) => {
  await page.route("**/api/settings/updates", (route) => route.fulfill({ json: { ...updateSettings, availability: "permission-required" } }));
  await openSettings(page);
  await expect(page.getByTestId("current-version")).toHaveText("0.1.0-alpha.4");
  await expect(page.getByRole("switch", { name: "Automatic updates" })).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("installation owner");
  await page.setViewportSize({ width: 320, height: 568 });
  await page.getByRole("button", { name: "Refresh status", exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Refresh status", exact: true })).toBeVisible();
  expect(await page.locator('[data-slot="settings-scroll"]').evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await assertViewportLocked(page);
});

test("the last result explains why an enabled automatic update is paused", async ({ page }) => {
  const state = structuredClone(updateSettings) as UpdateSettingsStatus;
  state.settings!.autoUpdate = true;
  state.settings!.timerActive = true;
  state.settings!.lastUpdate!.status = "failed";
  state.settings!.lastUpdate!.targetVersion = "0.1.0-alpha.5";
  await page.route("**/api/settings/updates", (route) => route.fulfill({ json: state }));
  await openSettings(page);
  await expect(page.getByText(/The last update failed/)).toBeVisible();
  await expect(page.getByText(/Automatic updates are paused/)).toBeVisible();
  await expect(page.getByTestId("current-version")).toHaveText("0.1.0-alpha.4");
});

test("a failed refresh marks the last known version and removes stale controls until recovery", async ({ page }) => {
  let online = true;
  await page.route("**/api/settings/updates", (route) => online ? route.fulfill({ json: updateSettings }) : route.abort("failed"));
  await openSettings(page);
  await expect(page.getByRole("switch", { name: "Automatic updates" })).toBeEnabled();
  online = false;
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(page.getByText("Last seen version", { exact: true })).toBeVisible();
  await expect(page.getByTestId("current-version")).toHaveText("0.1.0-alpha.4");
  await expect(page.getByRole("switch", { name: "Automatic updates" })).toHaveCount(0);
  online = true;
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(page.getByText("Current version", { exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Automatic updates" })).toBeEnabled();
});

test.describe("update settings with the real service worker", () => {
  test.use({ serviceWorkers: "allow" });
  test("offline requests never reuse cached settings or a stale server version", async ({ page, context }) => {
    await page.goto("/");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await page.evaluate(async () => {
      const cache = await caches.open("api");
      await cache.put("/api/settings/updates", new Response(JSON.stringify({ currentVersion: "9.9.9", availability: "available" }), {
        headers: { "content-type": "application/json" },
      }));
    });
    const online = await page.evaluate(async () => (await fetch("/api/settings/updates")).json());
    expect(online.currentVersion).toBe("0.1.0-alpha.4");
    await context.setOffline(true);
    const offline = await page.evaluate(async () => {
      try { return await (await fetch("/api/settings/updates")).json(); } catch { return null; }
    });
    expect(offline).toBeNull();
  });
});
