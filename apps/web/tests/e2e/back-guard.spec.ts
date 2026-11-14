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
  expect(await page.evaluate(guardMarker)).toBe("floor");
}

for (const hover of [true]) test(`the two-second exit window expires${hover ? " even while hovering the hint" : ""}`, async ({ page, context }) => {
  if (hover) await page.setViewportSize({ width: 1280, height: 900 });
  await rootWithClock(page);
  const cdp = await context.newCDPSession(page);
  const originalEntries = (await cdp.send("Page.getNavigationHistory")).entries.map(entry => entry.id);
  await pressBack(page);
  await expectFreshHint(page);
  if (hover) await exitHint(page).hover();
  await page.clock.runFor(2100);
  await expect(exitHint(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(guardMarker)).toBe("app");
  expect((await cdp.send("Page.getNavigationHistory")).entries.map(entry => entry.id)).toEqual(originalEntries);
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

for (const lifecycle of ["visibility"]) {
  test(`reopening after ${lifecycle} lifecycle signals resets each exit attempt without adding history`, async ({ page, context }) => {
    await rootWithClock(page);
    const cdp = await context.newCDPSession(page);
    const entries = (await cdp.send("Page.getNavigationHistory")).entries.map(entry => entry.id);
    for (let cycle = 0; cycle < 3; cycle++) {
      await pressBack(page);
      await expectFreshHint(page);
      // Lifecycle signals model a retained PWA document. OS window closing is
      // browser-owned; JS Back at its history boundary cannot simulate it.
      if (lifecycle === "freeze") {
        await page.evaluate(() => {
          document.dispatchEvent(new Event("freeze"));
          document.dispatchEvent(new Event("resume"));
        });
      } else {
        await page.evaluate(kind => {
          if (kind === "visibility") {
            Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
            document.dispatchEvent(new Event("visibilitychange"));
            Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
            document.dispatchEvent(new Event("visibilitychange"));
          } else {
            window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
            window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
          }
        }, lifecycle);
      }
      await page.clock.runFor(400);
      await expect(exitHint(page)).toHaveCount(0);
      await expect.poll(() => page.evaluate(guardMarker)).toBe("app");
      expect((await cdp.send("Page.getNavigationHistory")).entries.map(entry => entry.id)).toEqual(entries);
    }
    await pressBack(page);
    await expectFreshHint(page);
  });
}

async function visibility(page: Page, state: "hidden" | "visible") {
  await page.evaluate(value => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

test("time spent hidden does not traverse history or retain the exit deadline", async ({ page }) => {
  await rootWithClock(page);
  await pressBack(page);
  await expectFreshHint(page);
  await visibility(page, "hidden");
  await page.clock.runFor(10_000);
  await expect(exitHint(page)).toHaveCount(0);
  expect(await page.evaluate(guardMarker)).toBe("floor");
  await visibility(page, "visible");
  await expect.poll(() => page.evaluate(guardMarker)).toBe("app");
  await pressBack(page);
  await expectFreshHint(page);
  await page.clock.runFor(2100);
  await expect(exitHint(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(guardMarker)).toBe("app");
});

test("resuming preserves the current task, draft, and open layer", async ({ page, context }) => {
  await fakeStandalone(page);
  await page.goto("/");
  await page.getByText("Wire the web QA harness", { exact: true }).click();
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Keep this draft across app switching");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect.poll(() => page.evaluate(() => history.state?.__palmagentNavigation?.kind)).toBe("layer");
  const cdp = await context.newCDPSession(page);
  const before = await cdp.send("Page.getNavigationHistory");
  await visibility(page, "hidden");
  await visibility(page, "visible");
  expect(await cdp.send("Page.getNavigationHistory")).toEqual(before);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.evaluate(() => history.back());
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(draft).toHaveValue("Keep this draft across app switching");
  await expect(page).toHaveURL(/#\/task\/t-idle-rich$/);
});
