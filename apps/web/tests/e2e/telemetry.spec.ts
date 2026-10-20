import { test, expect } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";

test.use({ serviceWorkers: "block" });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pref:dispatch-repo", "repo-app"));
});
test("disclosure precedes sharing, off persists, and settings can enable it with a keyboard", async ({ page }) => {
  let state = { available: true, enabled: true, pendingDisclosure: true };
  const changes: unknown[] = [];
  await page.route("**/api/settings/telemetry", async route => {
    if (route.request().method() === "PATCH") {
      const change = route.request().postDataJSON(); changes.push(change);
      state = { ...state, ...change, pendingDisclosure: false };
    }
    await route.fulfill({ json: state });
  });
  await page.goto("/");
  const dialog = page.getByRole("dialog", { name: "Help improve Palmagent performance" });
  await expect(dialog).toBeVisible();
  expect(changes).toEqual([]);
  await expect(dialog).toContainText("180 days");
  await dialog.getByText("What is shared?", { exact: true }).click();
  await expect(dialog).toContainText("No conversations, code, file paths");
  await expect(dialog).toContainText("Node or Rust");
  await expect(page).toHaveScreenshot("telemetry-disclosure.png");
  await dialog.getByRole("button", { name: "Turn off sharing", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(changes).toEqual([{ enabled: false, retentionDays: 180 }]);
  await page.reload();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const control = page.getByRole("switch", { name: "Share performance metrics" });
  await control.scrollIntoViewIfNeeded();
  await expect(control).not.toBeChecked();
  await control.focus(); await page.keyboard.press("Space");
  await expect(control).toBeChecked();
  expect(changes).toEqual([{ enabled: false, retentionDays: 180 }, { enabled: true, retentionDays: 180 }]);
  await assertViewportLocked(page);
});
test("dismissal leaves sharing pending and failed saves retain a usable off action", async ({ page }) => {
  let writes = 0;
  await page.route("**/api/settings/telemetry", async route => {
    if (route.request().method() === "PATCH") {
      writes++; return route.fulfill({ status: 503, json: { error: "unavailable" } });
    }
    await route.fulfill({ json: { available: true, enabled: true, pendingDisclosure: true } });
  });
  await page.goto("/");
  const dialog = page.getByRole("dialog", { name: "Help improve Palmagent performance" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Turn off sharing" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Turn off sharing" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(writes).toBe(1);
});
