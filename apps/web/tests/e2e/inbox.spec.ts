import { test, expect, type Page } from "@playwright/test";
import { tasks, repos } from "../fixtures.mjs";
import { assertViewportLocked, captureForReview } from "./_helpers";
import { installInbox, send } from "./_inbox-stream";

async function filterStatus(page: Page, label: string) {
  await page.getByRole("button", { name: /^Filters(?:,|$)/ }).click();
  const sheet = page.getByRole("dialog", { name: "Task filters" });
  await sheet.getByRole("combobox", { name: "Status", exact: true }).click();
  await page.getByRole("option", { name: label, exact: true }).click();
  await sheet.getByRole("button", { name: "Done", exact: true }).click();
}

test.describe("inbox", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
    // Wait for the task snapshot to arrive over SSE (an idle task's title).
    await expect(page.getByText("Wire the web QA harness")).toBeVisible();
  });

  test("status filters work across Spaces, reveal folded matches, and restore on Back", async ({ page }) => {
    const group = page.getByRole("region", { name: "sample-app tasks", exact: true });
    const fold = group.getByRole("button", { name: "sample-app tasks", exact: true });
    await fold.click();
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    await filterStatus(page, "Needs answer");
    const attention = page.getByRole("region", { name: "Needs you", exact: true });
    await expect(attention.getByText("Scaffold a new settings screen", { exact: true })).toBeVisible();
    await expect(page.getByTestId("inbox-content").getByRole("button", { name: /^Actions for / })).toHaveCount(tasks.filter(task => task.status === "awaiting_input").length);
    await attention.getByRole("button", { name: /Scaffold a new settings screen/ }).first().click();
    await page.goBack();
    await expect(page.getByRole("button", { name: "Clear status filter" })).toContainText("Needs answer");
    await filterStatus(page, "Needs approval");
    await expect(page.getByTestId("inbox-content").getByRole("button", { name: /^Actions for / })).toHaveCount(tasks.filter(task => task.status === "awaiting_approval").length);
    await page.getByRole("button", { name: "Clear status filter" }).click();
    await expect(fold).toHaveAttribute("aria-expanded", "false");
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

test("response requests escape folded Spaces and return once when work resumes", async ({ page }) => {
  await installInbox(page);
  await page.goto("/");
  const content = page.getByTestId("inbox-content");
  const attention = content.getByRole("region", { name: "Needs you", exact: true });
  const group = content.getByRole("region", { name: "notes tasks", exact: true });
  const fold = group.getByRole("button", { name: "notes tasks", exact: true });
  await fold.click();
  const request = { ...tasks[0], taskId: "new-request", repoId: "repo-notes", title: "Choose a release target" };
  await send(page, { type: "tasks", tasks: [...tasks, request] });
  const row = attention.locator("[data-swipe-surface]").filter({ hasText: request.title });
  await expect(row).toBeVisible();
  await expect(row.getByText("notes", { exact: true })).toBeVisible();
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(content.getByRole("button", { name: `Actions for ${request.title}`, exact: true })).toHaveCount(1);
  await send(page, { type: "tasks", tasks: [...tasks, { ...request, status: "running", pendingInput: undefined }] });
  await expect(row).toHaveCount(0);
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await fold.click();
  await expect(group.getByText(request.title, { exact: true })).toBeVisible();
  await expect(content.getByRole("button", { name: `Actions for ${request.title}`, exact: true })).toHaveCount(1);
  await send(page, { type: "tasks", tasks: tasks.filter(task => !["awaiting_input", "awaiting_approval"].includes(task.status)) });
  await expect(attention).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No tasks yet" })).toHaveCount(0);
});

test("local and disconnected requests keep their real control state outside Needs you", async ({ page }) => {
  await installInbox(page);
  await page.goto("/");
  await expect(page.getByTestId("inbox-content").getByText("Scaffold a new settings screen", { exact: true })).toBeVisible();
  const control = { owner: "local" as const, home: "/sessions", transcript: "/sessions/local.jsonl", cursor: 0, prefixHash: "fixture" };
  await send(page, { type: "tasks", tasks: [
    { ...tasks[0], taskId: "local-request", title: "Local request", sessionControl: control },
    { ...tasks[0], taskId: "disconnected-request", title: "Disconnected request", sessionControl: { ...control, owner: "shared", connection: "reconnecting" } },
  ] });
  await expect(page.getByRole("region", { name: "Needs you", exact: true })).toHaveCount(0);
  const group = page.getByRole("region", { name: "sample-app tasks", exact: true });
  await expect(group.getByText("Local shell", { exact: true })).toBeVisible();
  await expect(group.getByText("Reconnecting", { exact: true })).toBeVisible();
  await send(page, { type: "tasks", tasks: [
    { ...tasks[0], taskId: "disconnected-request", title: "Reconnected request", sessionControl: { ...control, owner: "shared", connection: "connected" } },
  ] });
  await expect(page.getByRole("region", { name: "Needs you", exact: true }).getByText("Reconnected request", { exact: true })).toBeVisible();
});

for (const width of [320]) test(`attention rows keep Space context, search and navigation at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 780 });
  await installInbox(page);
  const longName = "A long Space name shared by multiple folders";
  await page.route("**/api/repos", route => route.fulfill({ json: { repos: [
    { ...repos[0], name: longName, path: "/projects/first/work" },
    { ...repos[1], name: longName, path: "/projects/second/work" },
  ] } }));
  await page.goto("/");
  await expect(page.getByTestId("inbox-content").getByText("Scaffold a new settings screen", { exact: true })).toBeVisible();
  await send(page, { type: "tasks", tasks: [tasks[0], { ...tasks[1], repoId: repos[1].id }] });
  const attention = page.getByRole("region", { name: "Needs you", exact: true });
  const context = attention.locator("[title]").filter({ hasText: longName });
  await expect(context).toHaveCount(2);
  await expect(context.filter({ hasText: "second/work" })).toHaveCount(1);
  const names = await context.allTextContents();
  expect(names[0]).not.toBe(names[1]);
  for (const row of await attention.locator("[data-swipe-surface]").all()) {
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const contextBox = (await row.locator("[title]").boundingBox())!;
    const timeBox = (await row.locator("time").boundingBox())!;
    expect(Math.abs(contextBox.y - timeBox.y)).toBeLessThan(2);
    expect(contextBox.x + contextBox.width).toBeLessThan(timeBox.x);
  }
  await assertViewportLocked(page);
  await captureForReview(page, `tasks-attention-${width}.png`);
  const search = page.getByRole("searchbox", { name: "Search tasks" });
  await search.fill("Scaffold");
  await expect(attention.locator("[data-swipe-surface]")).toHaveCount(1);
  const match = attention.locator("[data-swipe-surface]");
  await match.focus();
  await expect(match).toBeFocused();
  await match.press("Enter");
  await expect(page).toHaveURL(/#\/task\/t-input$/);
  await page.goBack();
  await expect(search).toHaveValue("Scaffold");
  await expect(attention.locator("[data-swipe-surface]")).toHaveCount(1);
});

test("one filter entry keeps zero-result statuses keyboard reachable", async ({ page }) => {
  await installInbox(page);
  await page.goto("/");
  const trigger = page.getByRole("button", { name: /^Filters(?:,|$)/ });
  await expect(trigger).toBeVisible();
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.getByRole("radiogroup", { name: "Quick task filters" })).toHaveCount(0);
  await send(page, { type: "tasks", tasks: tasks.filter(task => task.status === "idle") });
  await trigger.focus();
  await trigger.press("Enter");
  const sheet = page.getByRole("dialog", { name: "Task filters" });
  const select = sheet.getByRole("combobox", { name: "Status", exact: true });
  await select.focus();
  await select.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Needs approval", exact: true })).toBeVisible();
  await page.getByRole("option", { name: "Needs answer", exact: true }).click();
  await sheet.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByText("No tasks match these filters", { exact: true })).toBeVisible();
  await expect(page.getByText("0 tasks found", { exact: true })).toBeVisible();
  await expect(trigger).toHaveAccessibleName("Filters, 1 active");
  const chip = page.getByRole("button", { name: "Clear status filter" });
  await chip.focus();
  await chip.press("Enter");
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAccessibleName("Filters");
  await expect(chip).toHaveCount(0);
  await expect(page.getByText("Wire the web QA harness", { exact: true })).toBeVisible();
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
