import { test, expect, type Page } from "@playwright/test";

// The root back-guard (backGuard.ts) is standalone-only and otherwise invisible —
// it draws no UI until the system Back button is pressed, so screenshots can't
// see it. These specs assert the behavioral contract instead:
//   - installed as standalone → first back is absorbed (stays in-app + warns)
//   - a plain browser tab     → gate off, no history sentinel installed
//
// setupBackGuard() runs at module load in main.tsx, so we must fake the
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
    await expect(page.getByText("Press back again to exit")).toBeVisible();
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
