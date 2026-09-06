import { test, expect } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";

test.describe("dispatch form", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/#/new");
    await expect(page.getByRole("heading", { name: "Dispatch" })).toBeVisible();
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

  // Worktree isolation is opt-in and git-only. The toggle (below the fold, so the
  // visual baseline can't see it) must be present for a git repo and absent for a
  // plain folder, which always runs in place.
  test("shows the worktree-isolation toggle only for git repos", async ({ page }) => {
    // First repo (auto-selected) is the git repo → toggle present, default off.
    const toggle = page.getByRole("switch", { name: "Isolated worktree" });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    // Switch to the plain folder → the whole Isolation section disappears.
    await page.getByRole("combobox").filter({ hasText: "sample-app" }).click();
    await page.getByRole("option", { name: /notes/ }).click();
    await expect(page.getByRole("switch", { name: "Isolated worktree" })).toHaveCount(0);
  });
});
