import { test, expect } from "@playwright/test";
import { tasks, repos } from "../fixtures.mjs";
import { assertViewportLocked, captureForReview } from "./_helpers";
import { installInbox, send } from "./_inbox-stream";

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
    await page.getByRole("combobox", { name: "Task status", exact: true }).click();
    await page.getByRole("option", { name: "All tasks", exact: true }).click();
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

test("Done accordion retains folding through search and navigation, and fits live rows", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await installInbox(page);
  await page.goto("/#/spaces/repo-app");
  const visibleTasks = tasks.filter(task => task.repoId === "repo-app" && ["running", "idle"].includes(task.status));
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  await send(page, { type: "tasks", tasks: visibleTasks });
  const trigger = page.getByRole("button", { name: "Done", exact: true });
  const completed = page.getByText("Wire the web QA harness", { exact: true });
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const newTask = { ...visibleTasks.find(task => task.taskId === "t-idle-rich")!, taskId: "t-new-done", title: "Recently completed task", prs: [], lastActivityAt: 1 };
  await send(page, { type: "tasks", tasks: [...visibleTasks, newTask] });
  const region = page.getByRole("region", { name: "Done", exact: true });
  const lastRow = region.locator("[data-swipe-surface]").filter({ hasText: newTask.title });
  await expect(lastRow).toBeVisible();
  await expect.poll(async () => {
    const content = (await region.boundingBox())!;
    const row = (await lastRow.boundingBox())!;
    return row.y + row.height - content.y - content.height;
  }, { message: "newly completed rows must remain inside the expanded content" }).toBeLessThanOrEqual(1);

  await page.keyboard.press("Tab");
  await trigger.focus();
  await trigger.press("Enter");
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(completed).toBeHidden();

  await page.getByRole("searchbox", { name: "Search tasks" }).fill("QA");
  await expect(completed).toBeVisible();
  await expect(trigger).toHaveCount(0);
  await completed.click();
  await expect(page).toHaveURL(/#\/task\/t-idle-rich$/);
  await page.goBack();
  await expect(page.getByRole("searchbox", { name: "Search tasks" })).toHaveValue("QA");
  await page.getByRole("button", { name: "Clear task search" }).click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(completed).toBeHidden();
  await trigger.focus();
  await trigger.press("Space");
  await expect(trigger).toBeFocused();
  await expect(completed).toBeVisible();


  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 780 });
    await trigger.scrollIntoViewIfNeeded();
    await page.keyboard.press("Tab");
    await trigger.focus();
    const header = (await trigger.boundingBox())!;
    expect(header.height).toBeGreaterThanOrEqual(44);
    const insets = await trigger.evaluate(el => {
      const bounds = el.getBoundingClientRect();
      const label = document.createRange();
      label.selectNodeContents(el.querySelector("span")!);
      const icon = [...el.querySelectorAll("svg")].find(svg => svg.getBoundingClientRect().width > 0)!;
      return { left: label.getBoundingClientRect().left - bounds.left, right: bounds.right - icon.getBoundingClientRect().right,
        focusVisible: el.matches(":focus-visible"), borderColor: getComputedStyle(el).borderColor };
    });
    expect(insets.left).toBeGreaterThanOrEqual(12);
    expect(insets.right).toBeGreaterThanOrEqual(12);
    expect(insets.focusVisible).toBe(true);
    expect(insets.borderColor).not.toBe("rgba(0, 0, 0, 0)");
    await assertViewportLocked(page);
    await captureForReview(page, `done-accordion-focused-${width}.png`);
  }
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
  const assertDock = async () => {
    const action = (await create.boundingBox())!;
    const inputBox = (await search.boundingBox())!;
    const dock = (await form.boundingBox())!;
    const list = (await scrollArea.boundingBox())!;
    expect(action.y).toBeGreaterThanOrEqual(dock.y);
    expect(action.y + action.height).toBeLessThanOrEqual(dock.y + dock.height);
    expect(inputBox.x + inputBox.width).toBeLessThan(action.x);
    expect(Math.abs(action.y + action.height / 2 - inputBox.y - inputBox.height / 2)).toBeLessThan(2);
    expect(list.y + list.height <= dock.y || list.y >= dock.y + dock.height).toBe(true);
  };
  const initial = (await form.boundingBox())!;
  if (width < 768) {
    expect(initial.y).toBeGreaterThan(690);
  } else expect(initial.y).toBeLessThan(120);
  await assertDock();
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
      await assertDock();
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
  const lastRow = page.getByTestId("inbox-content").locator("[data-swipe-surface]").last();
  await expect(lastRow).toBeInViewport({ ratio: 1 });
  await expect.poll(async () => {
    const row = (await lastRow.boundingBox())!;
    return row.y + row.height - (await create.boundingBox())!.y;
  }).toBeLessThanOrEqual(0);
  await assertDock();
  await assertViewportLocked(page);
});


test("zero-count shortcuts stay quiet but all statuses remain keyboard reachable", async ({ page }) => {
  await installInbox(page);
  await page.goto("/");
  await expect(page.getByRole("combobox", { name: "Task status" })).toBeVisible();
  await send(page, { type: "tasks", tasks: tasks.filter(task => task.status === "idle") });
  await expect(page.getByRole("radio", { name: "Needs answer", exact: true })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Needs approval", exact: true })).toHaveCount(0);
  const select = page.getByRole("combobox", { name: "Task status" });
  await select.focus();
  await select.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Needs approval", exact: true })).toBeVisible();
  await page.getByRole("option", { name: "Needs answer", exact: true }).click();
  await expect(page.getByText("No tasks match these filters", { exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Needs answer", exact: true })).toHaveAttribute("aria-checked", "true");
  await select.click();
  await page.getByRole("option", { name: "All tasks", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Needs answer", exact: true })).toHaveCount(0);
});

test("compact rows retain prompt search and PR actions without opening the task", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto("/#/");
  const task = tasks.find(task => task.prs && task.prs.length > 1)!;
  const search = page.getByRole("searchbox", { name: "Search tasks" });
  await search.fill(task.prompt);
  const row = page.locator('[data-swipe-surface]').filter({ hasText: task.title! });
  await expect(row).toHaveCount(1);
  await expect(row.getByText(task.prompt, { exact: true })).toHaveCount(0);
  await expect(row.getByText(task.agent, { exact: true })).toHaveCount(0);
  const prs = row.getByRole("button", { name: `${task.prs!.length} pull requests` });
  const time = row.locator("time");
  const prBox = (await prs.boundingBox())!;
  const timeBox = (await time.boundingBox())!;
  expect(Math.abs(prBox.y - timeBox.y)).toBeLessThan(3);
  const listUrl = page.url();
  await prs.focus();
  await prs.press("Enter");
  await expect(page.getByRole("dialog", { name: "Pull requests" })).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("link")).toHaveCount(task.prs!.length);
  await expect(page).toHaveURL(listUrl);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Pull requests" })).toHaveCount(0);
  await expect(search).toHaveValue(task.prompt);
  await expect(page).toHaveURL(listUrl);
  await assertViewportLocked(page);
});
