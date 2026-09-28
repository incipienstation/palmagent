import { test, expect } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";

test.describe("inbox", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "All spaces" })).toBeVisible();
    // Wait for the task snapshot to arrive over SSE (an idle task's title).
    await expect(page.getByText("Wire the web QA harness")).toBeVisible();
  });

  test("sets the per-route document title (page-first + brand suffix)", async ({ page }) => {
    await expect(page).toHaveTitle("All spaces · PalmAgent");
  });

  test("renders every status group", async ({ page }) => {
    await assertViewportLocked(page);
    // Nothing the backend can emit may silently vanish from the inbox.
    for (const label of ["Needs your answer", "Needs your approval", "Working now", "Up next", "Done", "Failed", "Cancelled", "Archived"]) {
      await expect(page.getByRole("heading", { name: label, exact: true })).toBeVisible();
    }
  });

  test("pull-to-refresh updates data while retaining the list and search", async ({ page }) => {
    // Simulate pull-to-refresh: drag down from the top of the scroll pane
    // past THRESHOLD (64px at DAMP=0.5 → 128px of finger travel).
    const scrollArea = page.locator('.overscroll-contain:has([data-testid="inbox-content"])');
    const box = await scrollArea.boundingBox();
    if (!box) throw new Error("scroll area not found");
    const x = box.x + box.width / 2;
    const startY = box.y + 10;

    await page.getByRole("searchbox", { name: "Search tasks" }).fill("QA");
    const input = await page.getByRole("searchbox", { name: "Search tasks" }).elementHandle();
    let loads = 0; page.on("load", () => loads++);
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tasks");
    await page.evaluate(
      ([sx, sy, ey]) => {
        const el = document.querySelector('.overscroll-contain:has([data-testid="inbox-content"])')!;
        const dispatch = (type: string, cy: number) => {
          el.dispatchEvent(
            new TouchEvent(type, {
              bubbles: true,
              cancelable: true,
              touches: [new Touch({ identifier: 1, target: el, clientX: sx, clientY: cy })],
            }),
          );
        };
        dispatch("touchstart", sy);
        for (let y = sy; y <= ey; y += 8) dispatch("touchmove", y);
        dispatch("touchend", ey);
      },
      [x, startY, startY + 150] as [number, number, number],
    );
    await refreshed;
    await expect(page.getByRole("searchbox", { name: "Search tasks" })).toHaveValue("QA");
    expect(await input!.evaluate(el => el.isConnected)).toBe(true);
    expect(loads).toBe(0);
  });

});

for (const width of [320, 360, 1280]) test(`task search shares the inline-clear dock without overlapping New task at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 780 });
  await page.goto("/#/spaces/repo-app");
  const search = page.getByRole("searchbox", { name: "Search tasks" });
  const form = page.getByRole("search", { name: "Search tasks" });
  const create = page.getByRole("button", { name: "Dispatch new task" });
  await expect(search).toBeVisible();
  await expect(search).not.toBeFocused();
  const input = await search.elementHandle();
  const initial = (await form.boundingBox())!;
  if (width < 768) {
    expect(initial.y).toBeGreaterThan(690);
    const action = (await create.boundingBox())!;
    expect(action.y + action.height).toBeLessThan(initial.y);
    const list = (await page.locator('.overscroll-contain:has([data-testid="inbox-content"])').boundingBox())!;
    expect(list.y + list.height).toBeLessThanOrEqual(action.y);
  } else expect(initial.y).toBeLessThan(120);
  await search.fill("QA");
  const clear = page.getByRole("button", { name: "Clear task search" });
  expect(await clear.evaluate(el => el.closest('[data-slot="input-group"]') !== null)).toBe(true);
  expect((await form.boundingBox())!.width).toBe(initial.width);
  await clear.click();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await expect(clear).toHaveCount(0);
  await search.fill("QA");
  if (width < 768) {
    for (const height of [420, 780]) {
      await page.evaluate(height => {
        Object.defineProperty(window.visualViewport, "height", { configurable: true, value: height });
        window.visualViewport!.dispatchEvent(new Event("resize"));
      }, height);
      await expect.poll(async () => { const box = (await form.boundingBox())!; return box.y + box.height; }).toBeLessThanOrEqual(height);
      const action = (await create.boundingBox())!;
      expect(action.y + action.height).toBeLessThan((await form.boundingBox())!.y);
    }
    await expect(search).not.toBeFocused();
  } else {
    await page.setViewportSize({ width: 360, height: 780 });
    await expect.poll(async () => (await form.boundingBox())!.y).toBeGreaterThan(690);
  }
  await expect(search).toHaveValue("QA");
  expect(await input!.evaluate(el => el.isConnected)).toBe(true);
  await search.focus();
  await search.press("Escape");
  await expect(search).not.toBeFocused();
  await expect(search).toHaveValue("QA");
  await assertViewportLocked(page);
});
