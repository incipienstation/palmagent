import { routines } from "../fixtures.mjs";
import { test, expect } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";

test.describe("routines", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/#/routines");
    await expect(page.getByRole("heading", { name: "Routines" })).toBeVisible();
  });

  test("viewport is locked (no document scroll, no horizontal overflow)", async ({ page }) => {
    await assertViewportLocked(page);
  });

  test("sets the per-route document title", async ({ page }) => {
    await expect(page).toHaveTitle("Routines · PalmAgent");
  });

  test("renders friendly schedule labels for preset and manual routines", async ({ page }) => {
    // Compiled cron is read back into a human cadence on the card; a manual
    // routine shows "Manual" and no next-run.
    await expect(page.getByText("Weekdays at 09:00")).toBeVisible();
    await expect(page.getByText("Manual", { exact: true })).toBeVisible();
  });

  test("history expands to show recorded runs (incl. a skipped one)", async ({ page }) => {
    await page.getByRole("button", { name: "History", exact: true }).first().click();
    await expect(page.getByText("Skipped (server was down)")).toBeVisible();
    await expect(page.getByText("Ran on schedule").first()).toBeVisible();
  });

  test("the new-routine form offers schedule presets with a time picker", async ({ page }) => {
    await page.getByRole("button", { name: "New routine" }).click();
    await expect(page.getByText("Schedule", { exact: true })).toBeVisible();
    // Default preset is Daily, which reveals a Time picker (not a raw cron box).
    await expect(page.getByText("Time", { exact: true })).toBeVisible();
  });


  test("routine model efforts exclude legacy models and submit the selected effort", async ({ page }) => {
    await page.route("**/api/routines", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fulfill({ json: { routine: { ...routines[0], id: "r-created", ...route.request().postDataJSON() } } });
    });
    await page.getByRole("button", { name: "New routine" }).click();
    const form = page.locator("form");
    await form.getByRole("radio", { name: "codex", exact: true }).click();
    await form.getByRole("combobox", { name: "Model", exact: true }).click();
    await expect(page.getByRole("option", { name: /gpt-5\.4/ })).toHaveCount(0);
    await page.getByRole("option", { name: "gpt-5.6-luna", exact: true }).click();
    await form.getByRole("combobox", { name: "Effort", exact: true }).click();
    await expect(page.getByRole("option", { name: "ultra", exact: true })).toHaveCount(0);
    await page.getByRole("option", { name: "max", exact: true }).click();
    await assertViewportLocked(page);
    await form.locator("textarea").fill("Review the sample project on schedule.");
    const request = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/routines");
    await form.getByRole("button", { name: "Create routine", exact: true }).click();
    expect((await request).postDataJSON()).toMatchObject({ agent: "codex", model: "gpt-5.6-luna", effort: "max" });
  });
});

test("stale routine preferences cannot submit a retired model or unsupported effort", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("pref:routine-model", JSON.stringify({ codex: "gpt-5.4-mini" }));
    localStorage.setItem("pref:routine-effort", JSON.stringify({ codex: "minimal" }));
  });
  await page.goto("/#/routines");
  await page.route("**/api/routines", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({ json: { routine: { ...routines[0], id: "r-created", ...route.request().postDataJSON() } } });
  });
  await page.getByRole("button", { name: "New routine" }).click();
  const form = page.locator("form");
  await form.getByRole("radio", { name: "codex", exact: true }).click();
  await expect(form.getByRole("combobox", { name: "Model", exact: true })).toHaveText("default");
  await expect(form.getByRole("combobox", { name: "Effort", exact: true })).toHaveText("default");
  await form.locator("textarea").fill("Use current defaults");
  const request = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/routines");
  await form.getByRole("button", { name: "Create routine", exact: true }).click();
  const payload = (await request).postDataJSON();
  expect(payload.model).toBeUndefined();
  expect(payload.effort).toBeUndefined();
});
