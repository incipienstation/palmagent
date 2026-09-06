import { test, expect } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";

test.describe("task detail", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/#/task/t-idle-rich");
    await expect(page.getByRole("heading", { name: "Wire the web QA harness" })).toBeVisible();
    // The scoped stream replays in full synchronously; wait for the final line.
    await expect(page.getByText("Harness scaffolded and passing.")).toBeVisible();
  });

  test("viewport is locked (no document scroll, no horizontal overflow)", async ({ page }) => {
    await assertViewportLocked(page);
  });

  test("the event log never overflows horizontally, even with a long unbroken URL", async ({ page }) => {
    // Guards against Radix ScrollArea widening the document:
    // a long, space-free token must wrap inside the pane, never widen it.
    const overflow = await page.evaluate(() => {
      const vps = [...document.querySelectorAll("[data-radix-scroll-area-viewport]")] as HTMLElement[];
      const log = vps.find((el) => el.textContent?.includes("Harness scaffolded")) ?? vps[0];
      return log.scrollWidth - log.clientWidth;
    });
    expect(overflow, "event log pane overflows horizontally").toBeLessThanOrEqual(1);
  });

  test("shows the dispatch prompt as a You bubble and a follow-up composer", async ({ page }) => {
    await expect(page.getByText("You", { exact: true })).toBeVisible();
    // idle task → follow-up composer is enabled.
    await expect(page.getByPlaceholder(/Send a follow-up turn/)).toBeVisible();
  });

  test("matches the visual baseline", async ({ page }) => {
    await expect(page).toHaveScreenshot("task-detail.png");
  });

  test("the PR chip opens a bottom sheet listing every PR the task opened", async ({ page }) => {
    // t-idle-rich opened 3 PRs → the meta shows an "N PRs" chip, not a single link.
    await page.getByRole("button", { name: "3 pull requests" }).click();
    await expect(page.getByRole("heading", { name: "Pull requests" })).toBeVisible();
    // Every PR is listed by number + title, each linking out to GitHub.
    await expect(page.getByText("Mock SSE+REST server for tests")).toBeVisible();
    await expect(page.getByText("WIP: visual snapshot baselines")).toBeVisible();
    await expect(page.getByRole("link", { name: /Wire the web QA harness/ })).toHaveAttribute(
      "href",
      "https://github.com/acme/sample-app/pull/42",
    );
    await expect(page).toHaveScreenshot("pr-sheet.png");
  });

  test("tapping the scrim dismisses the PR sheet (vaul dismiss not swallowed by a wrapper)", async ({ page }) => {
    await page.getByRole("button", { name: "3 pull requests" }).click();
    await expect(page.getByRole("heading", { name: "Pull requests" })).toBeVisible();
    // Tap the overlay above the sheet — must close it (regression: a stop-propagation
    // wrapper around the sheet used to swallow vaul's overlay-dismiss click).
    await page.locator('[data-slot="sheet-overlay"]').click({ position: { x: 180, y: 120 } });
    await expect(page.getByRole("heading", { name: "Pull requests" })).toBeHidden();
  });

  test("renders assistant markdown (heading, GFM table, list) — and the table never widens the pane", async ({
    page,
  }) => {
    // The markdown-rendered assistant prose sits at the TOP of the log, which
    // auto-sticks to the bottom — scroll up to it (a real scroll so onScroll
    // releases the stick) and lock the render as a committed baseline.
    const viewport = page.locator("[data-radix-scroll-area-viewport]").first();
    await viewport.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    // Structural proof the markdown actually parsed (not raw `## ` / `|` text).
    await expect(page.getByRole("heading", { name: "Plan" })).toBeVisible();
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByRole("cell", { name: "Layout overflow" })).toBeVisible();
    // The GFM table is wrapped in an overflow-x-auto rail, so even a wide table
    // scrolls inside the pane and never widens the log (the mobile contract).
    const overflow = await viewport.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow, "markdown table widened the event log pane").toBeLessThanOrEqual(1);
    await expect(page).toHaveScreenshot("task-detail-markdown.png");
  });
});

test.describe("dispatch prompt from the event stream", () => {
  test("renders the dispatch prompt from the log, deduped against the snapshot", async ({ page }) => {
    // t-run carries both an inbox `prompt` and a `dispatch` event in its stream;
    // the bubble must come from the log (so it shows even pre-snapshot) and must
    // not double up with the prompt-prop fallback.
    await page.goto("/#/task/t-run");
    await expect(
      page.getByText("Refactor hub.ts so a misbehaving subscriber can never break fan-out to the others."),
    ).toBeVisible();
    await expect(page.getByText("You", { exact: true })).toHaveCount(1);
  });
});
