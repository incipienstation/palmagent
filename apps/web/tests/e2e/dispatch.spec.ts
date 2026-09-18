import { test, expect } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";

test.describe("dispatch form", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/#/new");
    await expect(page.getByRole("heading", { name: "New task" })).toBeVisible();
    await expect(page.getByLabel("Prompt")).toBeVisible();
  });

  test("viewport is locked (no document scroll, no horizontal overflow)", async ({ page }) => {
    await assertViewportLocked(page);
  });

  test("auto-selects the first registered repo", async ({ page }) => {
    // loadRepos() picks list[0] — the form must come up usable, not empty.
    // (Target the repo combobox; Radix also renders a hidden <option> mirror.)
    await expect(page.getByRole("combobox").filter({ hasText: "sample-app" })).toBeVisible();
  });

  test("matches the visual baseline", async ({ page }) => {
    await expect(page).toHaveScreenshot("dispatch.png");
  });

  test("remembers the selected Codex model and submits its exact identifier", async ({ page }) => {
    await page.getByLabel("Prompt").tap();
    await page.getByRole("button", { name: "Configure model and effort" }).click();
    await page.getByRole("radio", { name: "codex", exact: true }).click();
    await page.getByRole("radio", { name: "gpt-6-astra", exact: true }).click();
    await page.getByRole("radio", { name: "claude", exact: true }).click();
    await expect(page.getByRole("radio", { name: "gpt-6-astra", exact: true })).toHaveCount(0);
    await page.getByRole("radio", { name: "codex", exact: true }).click();
    await expect(page.getByRole("radio", { name: "gpt-6-astra", exact: true })).toBeVisible();
    await assertViewportLocked(page);
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByLabel("Prompt").fill("Review the sample project.");
    const request = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/tasks");
    await page.getByRole("button", { name: "Dispatch", exact: true }).click();
    expect((await request).postDataJSON()).toMatchObject({ agent: "codex", model: "gpt-6-astra" });
  });

  // Worktree isolation is opt-in and git-only. The toggle (below the fold, so the
  // visual baseline can't see it) must be present for a git repo and absent for a
  // plain folder, which always runs in place.
  test("shows the worktree-isolation toggle only for git repos", async ({ page }) => {
    // First repo (auto-selected) is the git repo → toggle present, default off.
    await page.getByLabel("Prompt").tap();
    await page.getByRole("button", { name: "Configure model and effort" }).click();
    const toggle = page.getByRole("switch", { name: "Isolated worktree" });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    await page.getByRole("button", { name: "Done", exact: true }).click();
    // Switch to the plain folder → the whole Isolation section disappears.
    await page.getByRole("combobox").filter({ hasText: "sample-app" }).click();
    await page.getByRole("option", { name: /notes/ }).click();
    await expect(page.getByRole("combobox", { name: "Working directory" })).toBeFocused();
    await page.getByLabel("Prompt").tap();
    await page.getByRole("button", { name: "Configure model and effort" }).click();
    await expect(page.getByRole("switch", { name: "Isolated worktree" })).toHaveCount(0);
  });
});

test("Codex effort choices follow each model and reset unsupported selections", async ({ page }, testInfo) => {
  await page.goto("/#/new");
  await page.getByLabel("Prompt").fill("Check model efforts");
  await page.getByRole("button", { name: "Configure model and effort" }).click();
  await page.getByRole("radio", { name: "codex", exact: true }).click();
  await expect(page.getByRole("radio", { name: /gpt-5\.4/ })).toHaveCount(0);
  const effort = page.getByRole("combobox", { name: "Effort", exact: true });
  for (const [model, extras] of [
    ["gpt-6-astra", ["max", "ultra"]],
    ["gpt-5.6-sol", ["max", "ultra"]],
    ["gpt-5.6-terra", ["max", "ultra"]],
    ["gpt-5.6-luna", ["max"]],
    ["gpt-5.5", []],
  ] as const) {
    await page.getByRole("radio", { name: model, exact: true }).click();
    await effort.click();
    await expect(page.getByRole("option")).toHaveText(["default", "low", "medium", "high", "xhigh", ...extras]);
    if (model === "gpt-6-astra") await page.screenshot({ path: testInfo.outputPath("codex-astra-efforts.png") });
    await page.getByRole("option", { name: extras.at(-1) ?? "xhigh", exact: true }).click();
  }
  await page.getByRole("radio", { name: "gpt-6-astra", exact: true }).click();
  await effort.click();
  await page.getByRole("option", { name: "ultra", exact: true }).click();
  await page.getByRole("radio", { name: "claude", exact: true }).click();
  await effort.click();
  await expect(page.getByRole("option", { name: "ultra", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("radio", { name: "codex", exact: true }).click();
  await expect(effort).toHaveText("ultra");
  await page.getByRole("radio", { name: "gpt-5.6-luna", exact: true }).click();
  await expect(effort).toHaveText("default");
  await page.getByRole("radio", { name: "gpt-6-astra", exact: true }).click();
  await expect(effort).toHaveText("default");
  await effort.click();
  await page.getByRole("option", { name: "ultra", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "Configure model and effort" })).toContainText("gpt-6-astra · ultra");
  const request = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/tasks");
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  expect((await request).postDataJSON()).toMatchObject({ agent: "codex", model: "gpt-6-astra", effort: "ultra" });
});

for (const model of ["gpt-5.4", "gpt-5.4-mini", "gpt-6-astra"]) test(`stale saved Codex selections are normalized before dispatch: ${model}`, async ({ page }) => {
  await page.addInitScript((model) => {
    localStorage.setItem("pref:dispatch-agent", "codex");
    localStorage.setItem("pref:dispatch-model", JSON.stringify({ codex: model }));
    localStorage.setItem("pref:dispatch-effort", JSON.stringify({ codex: "minimal" }));
  }, model);
  await page.goto("/#/new");
  await page.getByLabel("Prompt").fill("Use valid defaults");
  await expect(page.getByRole("button", { name: "Configure model and effort" })).toHaveText(model === "gpt-6-astra" ? model : "Codex");
  const request = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/tasks");
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  const payload = (await request).postDataJSON();
  expect(payload.effort).toBeUndefined();
  expect(payload.model).toBe(model === "gpt-6-astra" ? model : undefined);
});
