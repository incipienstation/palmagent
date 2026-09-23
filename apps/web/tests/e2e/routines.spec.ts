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
    await expect(page.getByRole("option", { name: "gpt-5.6-luna", exact: true })).toBeVisible();
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

test("script creation preserves the agent draft and submits code without agent settings", async ({ page }) => {
  await page.goto("/#/routines");
  await page.route("**/api/routines", async route => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({ json: { routine: { ...routines[0], id: "script-created", ...route.request().postDataJSON() } } });
  });
  await page.getByRole("button", { name: "New routine" }).click();
  const form = page.locator("form");
  await form.getByLabel("Prompt", { exact: true }).fill("Keep this agent draft");
  await form.getByRole("radio", { name: "Script", exact: true }).click();
  await expect(form.getByRole("combobox", { name: "Model" })).toHaveCount(0);
  await form.getByLabel("Script command").fill("node scripts/report.mjs");
  await form.getByLabel("Timeout (seconds)", { exact: true }).fill("60");
  await form.getByRole("radio", { name: "Agent task", exact: true }).click();
  await expect(form.getByLabel("Prompt", { exact: true })).toHaveValue("Keep this agent draft");
  await form.getByRole("radio", { name: "Script", exact: true }).click();
  await expect(form.getByLabel("Script command")).toHaveValue("node scripts/report.mjs");
  await assertViewportLocked(page);
  const request = page.waitForRequest(r => r.method() === "POST" && new URL(r.url()).pathname === "/api/routines");
  await form.getByRole("button", { name: "Create routine", exact: true }).click();
  const payload = (await request).postDataJSON();
  expect(payload).toMatchObject({ kind: "script", script: { command: "node scripts/report.mjs", timeoutSeconds: 60 } });
  expect(payload.agent).toBeUndefined(); expect(payload.prompt).toBeUndefined(); expect(payload.permission).toBeUndefined();
  await page.getByRole("button", { name: "New routine", exact: true }).click();
  await page.getByRole("radio", { name: "Agent task", exact: true }).click();
  await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue("Keep this agent draft");
});

for (const width of [360, 1280]) {
  test(`script history displays failure details and escaped output at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 780 });
    await page.route("**/api/routines", route => route.fulfill({ json: { routines: [{ ...routines[0], kind: "script", script: { command: "node scripts/report.mjs", timeoutSeconds: 60 } }] } }));
    await page.route("**/api/routines/*/runs", route => route.fulfill({ json: { runs: [{ id: 1, routineId: routines[0].id, firedAt: Date.now(), status: "failed", exitCode: 7, note: "script timed out", output: "<script>doNotExecute()</script>\nFailure details" }] } }));
    await page.goto("/#/routines");
    await page.getByRole("button", { name: "History", exact: true }).click();
    await expect(page.getByText("Exit code: 7", { exact: true })).toBeVisible();
    await expect(page.getByText("script timed out", { exact: true })).toBeVisible();
    await expect(page.locator("pre")).toContainText("<script>doNotExecute()</script>");
    await assertViewportLocked(page);
  });
}

test("open script history refreshes running results without the agent history cache", async ({ page }) => {
  let reads = 0;
  await page.route("**/api/routines", route => route.fulfill({ json: { routines: [{ ...routines[0], kind: "script", script: { command: "true", timeoutSeconds: 60 } }] } }));
  await page.route("**/api/routines/*/runs", route => route.fulfill({ json: { runs: [{ id: 1, routineId: routines[0].id, firedAt: Date.now(), status: ++reads === 1 ? "running" : "succeeded" }] } }));
  await page.goto("/#/routines");
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByText("Script running", { exact: true })).toBeVisible();
  await expect(page.getByText("Script succeeded", { exact: true })).toBeVisible({ timeout: 6000 });
  expect(reads).toBe(2);
});
