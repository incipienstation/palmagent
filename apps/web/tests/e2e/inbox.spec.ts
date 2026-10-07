import { test, expect } from "@playwright/test";
import { tasks, repos } from "../fixtures.mjs";
import { assertViewportLocked } from "./_helpers";

test.describe("inbox", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
    // Wait for the task snapshot to arrive over SSE (an idle task's title).
    await expect(page.getByText("Wire the web QA harness")).toBeVisible();
  });

  test("groups every task once by Space and retains explicit row status", async ({ page }) => {
    await expect(page).toHaveTitle("Tasks · PalmAgent");
    await assertViewportLocked(page);
    const content = page.getByTestId("inbox-content");
    await expect(content.getByRole("button", { name: /^Actions for / })).toHaveCount(tasks.length);
    for (const repo of repos) {
      const groupTasks = tasks.filter(task => task.repoId === repo.id);
      if (!groupTasks.length) continue;
      const group = content.getByRole("region", { name: `${repo.name} tasks`, exact: true });
      await expect(group.getByRole("button", { name: /^Actions for / })).toHaveCount(groupTasks.length);
      for (const task of groupTasks) await expect(group.getByRole("button", { name: `Actions for ${task.title || task.prompt.split("\n")[0]}`, exact: true })).toHaveCount(1);
    }
    for (const label of ["Needs answer", "Needs approval", "Working", "Queued", "Done", "Failed", "Cancelled", "Archived"]) {
      await expect(content.getByText(label, { exact: true }).first()).toBeVisible();
    }
  });

  test("attention shortcuts filter across Spaces, reveal folded matches, and restore on Back", async ({ page }) => {
    const group = page.getByRole("region", { name: "sample-app tasks", exact: true });
    const fold = group.getByRole("button", { name: "sample-app tasks", exact: true });
    await fold.click();
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("radio", { name: "Needs answer", exact: true }).click();
    await expect(group.getByText("Scaffold a new settings screen", { exact: true })).toBeVisible();
    await expect(page.getByTestId("inbox-content").getByRole("button", { name: /^Actions for / })).toHaveCount(tasks.filter(task => task.status === "awaiting_input").length);
    await group.getByRole("button", { name: /Scaffold a new settings screen/ }).first().click();
    await page.goBack();
    await expect(page.getByRole("radio", { name: "Needs answer", exact: true })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("radio", { name: "Needs approval", exact: true }).click();
    await expect(page.getByTestId("inbox-content").getByRole("button", { name: /^Actions for / })).toHaveCount(tasks.filter(task => task.status === "awaiting_approval").length);
    await page.getByRole("radio", { name: "All tasks", exact: true }).click();
    await expect(fold).toHaveAttribute("aria-expanded", "false");
  });

  test("Space group actions open that Space or start a task in it", async ({ page }) => {
    await page.getByRole("button", { name: "New task in notes", exact: true }).click();
    await expect(page).toHaveURL(/#\/new\/space\/repo-notes$/);
    await expect(page.getByRole("combobox", { name: "Space", exact: true })).toContainText("notes");
    await page.goBack();
    await page.getByRole("button", { name: "Open Space sample-app", exact: true }).click();
    await expect(page).toHaveURL(/#\/spaces\/repo-app$/);
    await expect(page.getByRole("heading", { name: "Working now", exact: true })).toBeVisible();
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
  await page.goto(width === 360 ? "/" : "/#/spaces/repo-app");
  const search = page.getByRole("searchbox", { name: "Search tasks" });
  const form = page.getByRole("search", { name: "Search tasks" });
  const create = page.getByRole("button", { name: "Dispatch new task" });
  await expect(search).toBeVisible();
  await expect(search).not.toBeFocused();
  const input = await search.elementHandle();
  const scrollArea = page.locator('.overscroll-contain:has([data-testid="inbox-content"])');
  const besideActionReachesList = async () => {
    const action = (await create.boundingBox())!;
    return scrollArea.evaluate((el, point) => el.contains(document.elementFromPoint(point.x, point.y)),
      { x: action.x - 12, y: action.y + action.height / 2 });
  };
  const initial = (await form.boundingBox())!;
  if (width < 768) {
    expect(initial.y).toBeGreaterThan(690);
    const action = (await create.boundingBox())!;
    expect(action.y + action.height).toBeLessThan(initial.y);
    const list = (await scrollArea.boundingBox())!;
    expect(list.y + list.height).toBeGreaterThan(action.y + action.height);
    await expect.poll(besideActionReachesList).toBe(true);
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
        document.documentElement.style.setProperty("--safe-bottom", height === 420 ? "34px" : "0px");
        Object.defineProperty(window.visualViewport, "height", { configurable: true, value: height });
        window.visualViewport!.dispatchEvent(new Event("resize"));
      }, height);
      await expect.poll(async () => { const box = (await form.boundingBox())!; return box.y + box.height; }).toBeLessThanOrEqual(height);
      const action = (await create.boundingBox())!;
      expect(action.y + action.height).toBeLessThan((await form.boundingBox())!.y);
      await expect.poll(besideActionReachesList).toBe(true);
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
  await clear.click();
  await search.press("Escape");
  await scrollArea.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const lastRow = page.getByTestId("inbox-content").locator("section").last().locator("button").first();
  await expect(lastRow).toBeInViewport({ ratio: 1 });
  await expect.poll(async () => {
    const row = (await lastRow.boundingBox())!;
    return row.y + row.height - (await create.boundingBox())!.y;
  }).toBeLessThanOrEqual(0);
  await expect.poll(besideActionReachesList).toBe(true);
  await assertViewportLocked(page);
});
