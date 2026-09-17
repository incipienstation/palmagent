import { test, expect } from "@playwright/test";
import { installScopedStream, send, event, open, viewport, expectBottom, type Harness } from "./_session-stream";

test.beforeEach(async ({ page }) => installScopedStream(page));

test("opens delayed history at the bottom and preserves live follow and reading position", async ({ page }) => {
  await open(page, "t-idle-rich");
  await send(page, "t-idle-rich", { type: "tasks", tasks: [], replayThrough: 3 });
  await event(page, "t-idle-rich", 1, "Earlier history\n\n".repeat(100));
  await expect(page.getByText("Loading history…")).toBeVisible();
  await expect(page.getByText(/Earlier history/)).toHaveCount(0);
  await event(page, "t-idle-rich", 2, "Middle history\n\n".repeat(100));
  await expect(page.getByText(/Middle history/)).toHaveCount(0);

  // Inspect every painted frame once history becomes visible, rather than
  // accepting a view which eventually reaches the bottom after scrolling.
  await page.evaluate(() => {
    const samples: number[] = [];
    Object.assign(window, { initialScrollSamples: samples });
    const sample = () => {
      const el = document.querySelector("[data-radix-scroll-area-viewport]");
      if (el?.textContent?.includes("Latest history") &&
          getComputedStyle(el.querySelector('[data-testid="virtuoso-item-list"]') ?? el).visibility === "visible") {
        samples.push(el.scrollHeight - el.clientHeight - el.scrollTop);
      }
      if (samples.length < 5) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await event(page, "t-idle-rich", 3, "Latest history");
  await expect(page.getByText("Loading history…")).toHaveCount(0);
  await expectBottom(page);
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { initialScrollSamples: number[] }).initialScrollSamples.length)).toBe(5);
  const samples = await page.evaluate(() =>
    (window as unknown as { initialScrollSamples: number[] }).initialScrollSamples);
  expect(samples.every((gap) => gap <= 1), `first visible frames: ${samples}`).toBe(true);

  await event(page, "t-idle-rich", 4, "\n\nLive update\n\n".repeat(20));
  await expect(page.getByText(/Live update/)).toHaveCount(20);
  await expectBottom(page);
  await viewport(page).evaluate((el) => {
    el.scrollTop = 100;
    el.dispatchEvent(new Event("scroll"));
  });
  await event(page, "t-idle-rich", 5, "\n\nWhile reading");
  await expect(page.getByText(/While reading/)).toHaveCount(1);
  expect(await viewport(page).evaluate((el) => el.scrollTop)).toBe(100);

  // Foreground reconnects keep the visible transcript and the reader's place.
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await send(page, "t-idle-rich", { type: "tasks", tasks: [], replayThrough: 6 });
  await event(page, "t-idle-rich", 5, "DUPLICATE");
  await event(page, "t-idle-rich", 6, "\n\nReconnected update");
  await expect(page.getByText(/Reconnected update/)).toHaveCount(1);
  await expect(page.getByText(/DUPLICATE/)).toHaveCount(0);
  expect(await viewport(page).evaluate((el) => el.scrollTop)).toBe(100);

  // A direct session switch must not inherit the previous session's scroll lock.
  await page.evaluate(() => { location.hash = "/task/t-run"; });
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as Harness).hasScopedStream("t-run"))).toBe(true);
  await send(page, "t-run", { type: "tasks", tasks: [], replayThrough: 1 });
  await expect(page.getByText(/Earlier history/)).toHaveCount(0);
  await event(page, "t-run", 1, "Other session\n\n".repeat(100));
  await expectBottom(page);
});

test("a reconnect during initial replay retains buffered history without duplicates", async ({ page }) => {
  await open(page, "t-idle-rich");
  await send(page, "t-idle-rich", { type: "tasks", tasks: [], replayThrough: 3 });
  await event(page, "t-idle-rich", 1, "Start\n\n");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await send(page, "t-idle-rich", { type: "tasks", tasks: [], replayThrough: 4 });
  await event(page, "t-idle-rich", 1, "DUPLICATE");
  await event(page, "t-idle-rich", 2, "Middle\n\n");
  await event(page, "t-idle-rich", 3, "End\n\n");
  await expect(page.getByText("Loading history…")).toBeVisible();
  await event(page, "t-idle-rich", 4, "Caught up");
  await expect(page.getByText("Start", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Caught up", { exact: true })).toHaveCount(1);
  await expect(page.getByText(/DUPLICATE/)).toHaveCount(0);
});

test("empty history and older servers do not leave a loading state", async ({ page }) => {
  await open(page, "t-run");
  await send(page, "t-run", { type: "tasks", tasks: [], replayThrough: 0 });
  await expect(page.getByText("Loading history…")).toHaveCount(0);
  await event(page, "t-run", 1, "First live message");
  await expect(page.getByText("First live message")).toBeVisible();
  await page.reload();
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as Harness).hasScopedStream("t-run"))).toBe(true);
  await send(page, "t-run", { type: "tasks", tasks: [] });
  await event(page, "t-run", 1, "Legacy history");
  await expect(page.getByText("Legacy history")).toBeVisible();
});


test("viewport resizing follows the bottom without moving a reader in older history", async ({ page }) => {
  await open(page, "t-idle-rich");
  await send(page, "t-idle-rich", { type: "tasks", tasks: [], replayThrough: 1 });
  await event(page, "t-idle-rich", 1, "Long session history\n\n".repeat(200));
  await expectBottom(page);
  await page.setViewportSize({ width: 360, height: 650 });
  await expectBottom(page);
  // scrollTop changes immediately, but the browser dispatches scroll later.
  // Wait for that event before simulating the subsequent keyboard resize.
  await viewport(page).evaluate((el) => new Promise<void>((resolve) => {
    el.addEventListener("scroll", () => resolve(), { once: true });
    el.scrollTop = 100;
  }));
  await expect.poll(() => viewport(page).evaluate((el) => el.scrollTop)).toBe(100);
  await page.setViewportSize({ width: 360, height: 600 });
  await event(page, "t-idle-rich", 2, "A new streamed line\n\n");
  await expect(page.getByText(/A new streamed line/)).toHaveCount(1);
  expect(await viewport(page).evaluate((el) => el.scrollTop)).toBe(100);
});
