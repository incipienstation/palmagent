import { test, expect, type Page } from "@playwright/test";

// The root back-guard (backGuard.ts) is standalone-only and otherwise invisible —
// it draws no UI until the system Back button is pressed, so screenshots can't
// see it. These specs assert the behavioral contract instead:
//   - installed as standalone → first back is absorbed (stays in-app + warns)
//   - a plain browser tab     → gate off, no history sentinel installed
//
// setupNavigation() runs before rendering in main.tsx, so we must fake the
// display-mode BEFORE the app boots — addInitScript runs before any page script.
// We special-case only the display-mode query so ThemeProvider's prefers-color
// matchMedia still works (the harness renders dark).
async function fakeStandalone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const orig = window.matchMedia.bind(window);
    window.matchMedia = ((q: string) => {
      if (q.includes("display-mode: standalone")) {
        return {
          matches: true,
          media: q,
          onchange: null,
          addEventListener() {},
          removeEventListener() {},
          addListener() {},
          removeListener() {},
          dispatchEvent: () => false,
        } as unknown as MediaQueryList;
      }
      return orig(q);
    }) as typeof window.matchMedia;
  });
}

const guardMarker = () => (history.state as { __backGuard?: string } | null)?.__backGuard;

test.describe("root back-guard (standalone)", () => {
  test("first back is absorbed — stays in-app, warns, and re-arms", async ({ page }) => {
    await fakeStandalone(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
    // The guard covered its floor sentinel with a live entry on boot.
    expect(await page.evaluate(guardMarker)).toBe("app");

    // Press the system Back button (drive history.back directly — same-document
    // popstate; avoids page.goBack()'s cross-document navigation wait).
    await page.evaluate(() => history.back());

    // Absorbed: the exit hint shows, the inbox is still mounted (app not closed),
    // and the guard re-covered the floor (armed for a second, real back).
    await expect(page.getByText("Press back again to exit", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
    expect(await page.evaluate(guardMarker)).toBe("app");
  });
});

test.describe("root back-guard (plain browser tab)", () => {
  test("gate off — no sentinel installed when not standalone", async ({ page }) => {
    // No fakeStandalone: headless chromium reports display-mode: browser.
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
    // The guard early-returns, so it never writes its history marker.
    expect(await page.evaluate(guardMarker)).toBeUndefined();
  });
});

const exitHint = (page: Page) => page.locator('[data-testid="toast"][data-front="true"][data-removed="false"]');
async function pressBack(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => {
    window.addEventListener("popstate", () => resolve(), { once: true });
    history.back();
  }));
  await page.clock.runFor(50);
}
async function rootWithClock(page: Page) {
  await fakeStandalone(page);
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  await page.clock.pauseAt(new Date("2026-01-01T00:01:00Z"));
}
async function expectFreshHint(page: Page) {
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  await expect(exitHint(page)).toContainText("Press back again to exit");
  expect(await page.evaluate(guardMarker)).toBe("app");
}

for (const hover of [false, true]) test(`the two-second exit window expires${hover ? " even while hovering the hint" : ""}`, async ({ page }) => {
  if (hover) await page.setViewportSize({ width: 1280, height: 900 });
  await rootWithClock(page);
  await pressBack(page);
  await expectFreshHint(page);
  if (hover) await exitHint(page).hover();
  await page.clock.runFor(2100);
  await expect(exitHint(page)).toHaveCount(0);
  await pressBack(page);
  await expectFreshHint(page);
});

test("Escape dismissal resets the exit window before its deadline", async ({ page }) => {
  await rootWithClock(page);
  await pressBack(page);
  await exitHint(page).focus();
  await page.keyboard.press("Escape");
  await page.clock.runFor(400);
  await expect(exitHint(page)).toHaveCount(0);
  await pressBack(page);
  await expectFreshHint(page);
});

test("swiping the exit hint resets the window before its deadline", async ({ page, context }) => {
  await rootWithClock(page);
  await pressBack(page);
  const box = (await exitHint(page).boundingBox())!;
  const cdp = await context.newCDPSession(page);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  for (const dy of [5, 10, 20, 30, 65]) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, y: point.y + dy }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.clock.runFor(400);
  await expect(page.getByTestId("toast")).toHaveCount(0);
  await pressBack(page);
  await expectFreshHint(page);
});

test("replacing the exit hint with late request feedback resets the window", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await page.route("**/api/tasks", async route => {
    if (route.request().method() !== "POST") return route.continue();
    requested = true;
    await pending;
    await route.fulfill({ status: 503, json: { error: "Delayed dispatch failure" } });
  });
  await rootWithClock(page);
  await page.getByRole("button", { name: "Dispatch new task", exact: true }).click();
  await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("Pending task");
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  await expect.poll(() => requested).toBe(true);
  await pressBack(page);
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  await pressBack(page);
  await expectFreshHint(page);
  const armedAt = await page.evaluate(() => Date.now());
  const failed = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/tasks"));
  release();
  await failed;
  await expect.poll(async () => {
    await page.clock.runFor(50);
    return exitHint(page).textContent();
  }).toContain("Couldn't dispatch");
  await page.clock.runFor(400);
  expect(await page.evaluate(() => Date.now()) - armedAt).toBeLessThan(1900);
  await pressBack(page);
  await expectFreshHint(page);
});

test("opening navigation dismisses the exit hint and disarms it", async ({ page }) => {
  await rootWithClock(page);
  await pressBack(page);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.clock.runFor(400);
  await expect(exitHint(page)).toHaveCount(0);
  await pressBack(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await pressBack(page);
  await expectFreshHint(page);
});
