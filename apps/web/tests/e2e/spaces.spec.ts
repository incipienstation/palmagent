import { test, expect, type Page } from "@playwright/test";
import { repos, tasks } from "../fixtures.mjs";
import { assertViewportLocked } from "./_helpers";

test.use({ serviceWorkers: "block" });

const root = "/projects/platform/clients/long-running-projects/customer-experience";
const longName = "a-very-long-project-name-that-must-never-widen-the-phone-screen";
const fixtureRepos = [
  { ...repos[0], id: "main", name: "palmagent", path: `${root}/palmagent` },
  { ...repos[0], id: "other", name: "palmagent", path: "/projects/experiments/palmagent" },
  { ...repos[0], id: "long", name: longName, path: `${root}/${longName}` },
];
const fixtureTasks = [
  { ...tasks[0], taskId: "main-task", repoId: "main", title: "Review the space picker", branch: undefined, worktreePath: undefined },
  ...Array.from({ length: 12 }, (_, i) => ({
    ...tasks[0], taskId: `work-${i}`, repoId: "main", title: `Worktree task ${i}`,
    branch: `feature/session-${i}`, worktreePath: `${root}/palmagent/.palmagent/worktrees/session-${String(i).padStart(2, "0")}`,
  })),
];

async function setup(page: Page) {
  await page.route("**/api/repos", (route) => route.fulfill({ json: { repos: fixtureRepos } }));
  await page.route("**/api/stream*", (route) => route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "tasks", tasks: fixtureTasks })}\n\n` }));
  await page.goto("/");
  await expect(page.getByText("Review the space picker", { exact: true })).toBeVisible();
}

// Check the overlay itself: overflow:hidden on the document can otherwise mask
// a portaled menu that extends beyond the screen (the original regression).
async function assertSheetFits(page: Page) {
  await assertViewportLocked(page);
  const dialog = page.getByRole("dialog", { name: "Spaces", exact: true });
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  for (const row of await dialog.getByRole("button").all()) {
    if (!await row.isVisible()) continue;
    expect(await row.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  }
}

test("space selection survives reload and long paths fit a narrow phone", async ({ page }) => {
  const width = 320;
  await page.setViewportSize({ width, height: 780 });
  await setup(page);
  const trigger = page.getByRole("button", { name: /^Switch space:/ });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Spaces", exact: true });
  await expect(dialog.getByRole("button", { name: "Close spaces" })).toBeFocused();
  await expect(dialog.getByRole("button", { name: /^Worktrees/ })).toHaveAttribute("aria-expanded", "false");
  await expect(dialog.getByText(fixtureRepos[0].path, { exact: true })).toBeVisible();
  await expect(dialog.getByText(fixtureRepos[1].path, { exact: true })).toBeVisible();
  await assertSheetFits(page);

  // Search includes collapsed worktrees and the full, unabridged path.
  await dialog.getByRole("searchbox", { name: "Search spaces" }).fill("session-11");
  const result = dialog.getByRole("button", { name: /session-11.*1 tasks/ });
  await expect(result).toBeVisible();
  await assertSheetFits(page);
  await result.click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toContainText("session-11");
  await expect(page.getByText("Worktree task 11", { exact: true })).toBeVisible();
  await expect(page.getByText("Review the space picker", { exact: true })).toBeHidden();
  await page.reload();
  await expect(trigger).toContainText("session-11");
  await trigger.click();
  await expect(dialog.getByRole("button", { name: /^Worktrees/ })).toHaveAttribute("aria-expanded", "true");
  await dialog.getByRole("searchbox").fill("nothing-matches");
  await expect(dialog.getByRole("status")).toContainText("No spaces found");
  await dialog.getByRole("button", { name: "Clear search" }).click();
  await expect(dialog.getByRole("searchbox")).toHaveValue("");
  await dialog.getByRole("button", { name: /All spaces/ }).click();
  await expect(page.getByText("Review the space picker", { exact: true })).toBeVisible();

  await trigger.click();
  await dialog.getByRole("button", { name: new RegExp(longName) }).click();
  await expect(trigger).toContainText(longName);
  expect(await trigger.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect(page.getByText("No tasks in this directory")).toBeVisible();
  await assertViewportLocked(page);
});

test("space sheet scrolls with a short viewport and closes by keyboard with focus restored", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 420 });
  await setup(page);
  const trigger = page.getByRole("button", { name: /^Switch space:/ });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Spaces", exact: true });
  await dialog.getByRole("searchbox").fill("session-11");
  const result = dialog.getByRole("button", { name: /session-11.*1 tasks/ });
  await result.scrollIntoViewIfNeeded();
  await expect(result).toBeInViewport();
  await assertSheetFits(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("desktop space search and light mobile sheet keep paths readable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await setup(page);
  const nav = page.getByRole("navigation", { name: "Spaces", exact: true });
  await nav.getByRole("searchbox").fill("experiments");
  await nav.getByRole("button", { name: /palmagent.*experiments/ }).click();
  await expect(page.getByText("No tasks in this directory")).toBeVisible();
  await assertViewportLocked(page);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto("/?__theme=light");
  await page.getByRole("button", { name: /^Switch space:/ }).click();
  await assertSheetFits(page);
});

test("project spaces include worktrees, reset search, and inherit into New task", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pref:dispatch-repo", "other"));
  await setup(page);
  const trigger = page.getByRole("button", { name: /^Switch space:/ });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Spaces", exact: true });
  const project = dialog.locator(`button[title="${fixtureRepos[0].path}"]`);
  await project.click();
  await expect(page.getByText("Review the space picker", { exact: true })).toBeVisible();
  await expect(page.getByText("Worktree task 11", { exact: true })).toBeVisible();

  const search = page.getByRole("searchbox", { name: "Search tasks" });
  await search.fill("Review the space picker");
  await expect(page.getByText("Review the space picker", { exact: true })).toBeVisible();
  await trigger.click();
  await page.getByRole("dialog", { name: "Spaces", exact: true }).locator(`button[title="${fixtureRepos[2].path}"]`).click();
  await expect(search).toHaveValue("");

  await trigger.click();
  await page.getByRole("dialog", { name: "Spaces", exact: true }).locator(`button[title="${fixtureRepos[0].path}"]`).click();
  await page.getByRole("button", { name: "Dispatch new task", exact: true }).click();
  await expect(page.getByRole("heading", { name: "New task", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Working directory" })).toHaveText("palmagent (main)");
  await expect(page.getByText("Inherited from Space: palmagent", { exact: true })).toBeVisible();
});
