import { test, expect } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";

// The "output mode" setting (Settings → Detail) governs how much agent MACHINERY
// the event log shows. t-idle-nginx carries a raw status + tool work + a long,
// multi-line tool_result (with an unbreakable URL) so the collapse/expand
// affordance, its horizontal-overflow containment, and the per-mode defaults can
// all be exercised on the Galaxy S25 (360×780) viewport.

const HEADING = "Tighten the nginx rate limits";
// In the collapsed one-line summary (first 400 chars of the output):
const IN_SUMMARY = "x-accel-buffering";
// Only in the FULL output, past the 400-char cap → revealed only when expanded:
const ONLY_WHEN_EXPANDED = "zero 503s under the new nginx.conf";

test.describe("output mode — machinery density", () => {
  test("default: a long machinery row is collapsed; tapping expands it without overflowing the pane", async ({
    page,
  }) => {
    await page.goto("/#/task/t-idle-nginx");
    await expect(page.getByRole("heading", { name: HEADING })).toBeVisible();

    // The long tool_result collapses to a one-line summary → an expandable row
    // (role=button). Its tail is not in the DOM yet.
    const row = page.getByRole("button", { name: new RegExp(IN_SUMMARY) });
    await expect(row).toBeVisible();
    await expect(page.getByText(ONLY_WHEN_EXPANDED)).toHaveCount(0);

    await row.click();

    // Now the full, untruncated output is shown…
    await expect(page.getByText(ONLY_WHEN_EXPANDED)).toBeVisible();
    // …and neither the document nor the log pane overflows horizontally — the
    // unbreakable URL wraps inside the pane (the mobile contract).
    await assertViewportLocked(page);
    const overflow = await page
      .locator("[data-radix-scroll-area-viewport]")
      .first()
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow, "expanded machinery output widened the event log pane").toBeLessThanOrEqual(1);

    await expect(page).toHaveScreenshot("output-mode-expanded.png");
  });

  test("verbose: machinery is expanded by default (no tap)", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("pref:output-mode", "verbose"));
    await page.goto("/#/task/t-idle-nginx");
    await expect(page.getByRole("heading", { name: HEADING })).toBeVisible();

    // Full output is shown on load — no interaction needed.
    await expect(page.getByText(ONLY_WHEN_EXPANDED)).toBeVisible();
    await assertViewportLocked(page);
  });

  test("compact: raw status lifecycle noise is hidden, tool work stays", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("pref:output-mode", "compact"));
    await page.goto("/#/task/t-idle-nginx");
    await expect(page.getByRole("heading", { name: HEADING })).toBeVisible();

    // The "session started" init status is dropped…
    await expect(page.getByText("session started")).toHaveCount(0);
    // …but the assistant prose and the (collapsed) tool work remain.
    await expect(page.getByText("Adding a per-IP")).toBeVisible();
    await expect(page.getByText(IN_SUMMARY)).toBeVisible();
  });
});
