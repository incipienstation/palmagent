import { test, expect } from "@playwright/test";
import { tasks, usage, repos } from "../fixtures.mjs";
import { assertViewportLocked } from "./_helpers";

test.use({ serviceWorkers: "block" });

test("the inbox distinguishes a pending snapshot, an empty list, and populated search results", async ({ page }) => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/stream*", async route => {
    await waiting;
    await route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "tasks", tasks: [] })}\n\n` });
  });
  await page.goto("/");
  await expect(page.getByTestId("inbox-content").getByRole("status")).toContainText("Loading tasks");
  await expect(page.getByText("No tasks yet", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Loading spaces…" })).toBeDisabled();
  release();
  await expect(page.getByText("No tasks yet", { exact: true })).toBeVisible();
  await page.unroute("**/api/stream*");
  await page.reload();
  const input = page.getByRole("searchbox", { name: "Search tasks" });
  await input.fill("Wire the web QA harness");
  await expect(page.getByTestId("inbox-content").getByRole("status")).toHaveText("1 task found");
  await expect(page.getByRole("heading", { name: "Working now", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Clear task search" }).click();
  const done = page.getByRole("button", { name: "Done", exact: true });
  await done.click();
  await expect(page.getByText("Wire the web QA harness", { exact: true })).toBeHidden();
  await input.fill("Wire the web QA harness");
  await expect(page.getByText("Wire the web QA harness", { exact: true })).toBeVisible();
  await input.fill("no matching task phrase");
  await expect(page.getByText("No matching tasks", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(input).toBeFocused();
  await input.fill(tasks.find(task => task.taskId === "t-run")!.prompt);
  await expect(page.getByTestId("inbox-content").getByRole("status")).toHaveText("1 task found");
});

test("Usage and routine history recover from read failures without false empty results", async ({ page }) => {
  let failUsage = true;
  await page.route("**/api/usage", route => failUsage
    ? route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } })
    : route.fulfill({ json: { usage } }));
  await page.goto("/#/usage");
  await expect(page.getByRole("alert")).toContainText("Couldn't load usage");
  failUsage = false;
  await page.getByRole("button", { name: "Retry usage" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("claude", { exact: true })).toBeVisible();
  let failHistory = true;
  await page.route("**/api/routines/r-standup/runs", route => failHistory
    ? route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } })
    : route.fulfill({ json: { runs: [] } }));
  await page.goto("/#/routines");
  await page.getByRole("button", { name: /History/ }).first().click();
  await expect(page.getByRole("alert")).toContainText("Couldn't load history");
  await expect(page.getByText("No runs yet.", { exact: true })).toHaveCount(0);
  failHistory = false;
  await page.getByRole("button", { name: "Retry history" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("No runs yet.", { exact: true })).toBeVisible();
});

test("Settings tabs preserve a folder draft and fit a narrow phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  const box = (await settings.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await settings.click();
  await page.getByRole("tab", { name: "Spaces", exact: true }).click();
  const input = page.getByRole("region", { name: "Space search paths" }).getByRole("textbox");
  await input.fill("/projects/unfinished");
  await page.getByRole("tab", { name: "General", exact: true }).click();
  await expect(input).toBeHidden();
  await page.getByRole("tab", { name: "Spaces", exact: true }).click();
  await expect(input).toHaveValue("/projects/unfinished");
  const tabTop = (await page.getByRole("tab", { name: "General", exact: true }).boundingBox())!.y;
  for (const name of ["General", "Spaces", "Updates"]) {
    const tab = page.getByRole("tab", { name, exact: true });
    await tab.click();
    expect((await tab.boundingBox())!.y).toBeCloseTo(tabTop, 0);
    expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(page.locator('[data-slot="settings-scroll"]:visible')).toHaveCount(1);
    await assertViewportLocked(page);
  }
});


test("task search stays within the selected Space", async ({ page }) => {
  const fixtureTasks = repos.slice(0, 2).map((repo, index) => ({
    ...tasks[0], taskId: `search-${index}`, repoId: repo.id, title: `Matching task ${index}`,
    prompt: "A shared search phrase", branch: undefined, worktreePath: undefined,
  }));
  await page.route("**/api/stream*", route => route.fulfill({ contentType: "text/event-stream",
    body: `data: ${JSON.stringify({ type: "tasks", tasks: fixtureTasks })}\n\n` }));
  await page.addInitScript(path => localStorage.setItem("working-directory", path), repos[0].path);
  await page.goto("/");
  await page.getByRole("searchbox", { name: "Search tasks" }).fill("shared search phrase");
  await expect(page.getByText("Matching task 0", { exact: true })).toBeVisible();
  await expect(page.getByText("Matching task 1", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("inbox-content").getByRole("status")).toHaveText("1 task found");
});
