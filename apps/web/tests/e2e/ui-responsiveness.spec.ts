import { test, expect } from "@playwright/test";
import { tasks } from "../fixtures.mjs";
import { installScopedStream, open, send, event, viewport } from "./_session-stream";

test.use({ serviceWorkers: "block" });

test("Back restores the inbox search, completed-group state, and scroll position", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("searchbox", { name: "Search tasks" }).fill("the");
  await expect(page.getByText("Wire the web QA harness", { exact: true })).toBeVisible();
  await viewport(page).evaluate(el => { el.scrollTop = 500; });
  // Use an actual visible row and record the scroll after Playwright brings it into view.
  const target = page.getByRole("button", { name: /Wire the web QA harness/ }).first();
  await target.scrollIntoViewIfNeeded();
  const top = await viewport(page).evaluate(el => el.scrollTop);
  await target.click();
  await expect(page).toHaveURL(/task\/t-idle-rich/);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "Search tasks" })).toHaveValue("the");
  await expect.poll(() => viewport(page).evaluate(el => el.scrollTop)).toBeCloseTo(top, 0);
  await page.getByRole("button", { name: "Clear task search" }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Dispatch new task" }).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("button", { name: "Done", exact: true })).toHaveAttribute("aria-expanded", "false");
});

test("large Markdown preserves cross-block references, tables, literal HTML and streamed final text", async ({ page }) => {
  await installScopedStream(page);
  await open(page, "t-run");
  await send(page, "t-run", { type: "tasks", tasks, replayThrough: 1 });
  const text = "Paragraph with **emphasis**.\n\n".repeat(180) +
    "[Late reference][target]\n\n<script>window.markdownExecuted=true</script>\n\n" +
    "[Unsafe](javascript:alert(1))\n\n| A | B |\n|---|---|\n| one | two |\n\n```ts\nconst sample = 1;\n";
  await event(page, "t-run", 1, text);
  await expect(page.getByRole("cell", { name: "two", exact: true })).toBeVisible();
  await event(page, "t-run", 2, "```\n\n[target]: https://example.invalid/docs\n\nFinal streamed answer");
  await expect(page.getByRole("link", { name: "Late reference" })).toHaveAttribute("href", "https://example.invalid/docs");
  await expect(page.getByRole("link", { name: "Unsafe", exact: true })).toHaveAttribute("href", "");
  await expect(viewport(page)).toContainText("<script>window.markdownExecuted=true</script>");
  await expect(viewport(page).locator("script")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { markdownExecuted?: boolean }).markdownExecuted)).toBeUndefined();
  await expect(page.getByText("Final streamed answer", { exact: true })).toBeVisible();
  await expect(page.locator("pre code")).toHaveText("const sample = 1;\n");
  // Keep the composer usable while newer versions of this same message arrive.
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("A draft while streaming");
  for (let seq = 3; seq <= 10; seq++) await event(page, "t-run", seq, `\n\nUpdate ${seq}`);
  await expect(page.getByText("Update 10", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("A draft while streaming");
});

test("unavailable Markdown workers retain readable content and later deltas", async ({ page }) => {
  await page.addInitScript(() => { window.Worker = class { constructor() { throw new Error("Worker unavailable"); } } as unknown as typeof Worker; });
  await installScopedStream(page);
  await open(page, "t-run");
  await send(page, "t-run", { type: "tasks", tasks, replayThrough: 1 });
  await event(page, "t-run", 1, "Readable fallback ".repeat(300));
  await expect(page.getByText(/Readable fallback/)).toBeVisible();
  await event(page, "t-run", 2, " Last delta");
  await expect(page.getByText(/Last delta/)).toBeVisible();
});

test("each Space retains its own inbox reading position", async ({ page }) => {
  const sample = tasks.find(task => task.taskId === "t-idle-rich")!;
  const list = Array.from({ length: 60 }, (_, index) => ({ ...sample, taskId: `reading-${index}`,
    title: `Reading position ${index}`, repoId: index % 2 ? "repo-app" : "repo-notes", prs: [], branch: undefined, worktreePath: undefined }));
  await page.route("**/api/stream*", route => route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "tasks", tasks: list })}\n\n` }));
  await page.goto("/");
  await page.getByRole("searchbox", { name: "Search tasks" }).waitFor();
  await viewport(page).evaluate(el => { el.scrollTop = 600; });
  await page.getByRole("button", { name: /^Switch space:/ }).click();
  await page.getByRole("dialog", { name: "Spaces", exact: true }).locator('button[title="/projects/sample-app"]').click();
  await expect.poll(() => viewport(page).evaluate(el => el.scrollTop)).toBe(0);
  await viewport(page).evaluate(el => { el.scrollTop = 300; });
  await page.getByRole("button", { name: /^Switch space:/ }).click();
  await page.getByRole("dialog", { name: "Spaces", exact: true }).getByRole("button", { name: /All spaces/ }).click();
  await expect.poll(() => viewport(page).evaluate(el => el.scrollTop)).toBe(600);
  await page.getByRole("button", { name: /^Switch space:/ }).click();
  await page.getByRole("dialog", { name: "Spaces", exact: true }).locator('button[title="/projects/sample-app"]').click();
  await expect.poll(() => viewport(page).evaluate(el => el.scrollTop)).toBe(300);
});

test.describe("long Markdown with the real service worker", () => {
  test.use({ serviceWorkers: "allow" });
  test("the parser is available offline before any long message has been opened", async ({ page, context }) => {
    await installScopedStream(page);
    await open(page, "t-run");
    await send(page, "t-run", { type: "tasks", tasks, replayThrough: 0 });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await context.setOffline(true);
    await event(page, "t-run", 1, "## Offline Markdown\n\n" + "Offline **formatted** paragraph.\n\n".repeat(180));
    await expect(page.getByRole("heading", { name: "Offline Markdown", exact: true })).toHaveCount(1);
    await expect(page.locator("strong").filter({ hasText: "formatted" })).toHaveCount(180);
  });
});
