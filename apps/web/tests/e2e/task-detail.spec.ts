import { test, expect } from "@playwright/test";
import { openSessionDetails } from "./_helpers";

test.describe("task detail", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/#/task/t-idle-rich");
    await expect(page.getByRole("heading", { name: "Wire the web QA harness" })).toBeVisible();
    // The scoped stream replays in full synchronously; wait for the final line.
    await expect(page.getByText("Harness scaffolded and passing.")).toBeVisible();
  });

  test("session details lists PRs and restores focus after scrim dismissal", async ({ page }) => {
    // Task links share the details sheet with configuration and handoff.
    await openSessionDetails(page);
    await expect(page.getByRole("heading", { name: "Pull requests" })).toBeVisible();
    // Every PR is listed by number + title, each linking out to GitHub.
    await expect(page.getByText("Mock SSE+REST server for tests")).toBeVisible();
    await expect(page.getByText("WIP: visual snapshot baselines")).toBeVisible();
    await expect(page.getByRole("link", { name: /Wire the web QA harness/ })).toHaveAttribute(
      "href",
      "https://github.com/acme/sample-app/pull/42",
    );
    // Tap the overlay above the sheet — must close it (regression: a stop-propagation
    // wrapper around the sheet used to swallow vaul's overlay-dismiss click).
    await page.locator('[data-slot="drawer-overlay"]').click({ position: { x: 180, y: 10 } });
    await expect(page.getByRole("heading", { name: "Pull requests" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Task actions", exact: true })).toBeFocused();
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
    await expect(page.getByRole("group", { name: "Your message", exact: true })).toHaveCount(1);
  });
});
