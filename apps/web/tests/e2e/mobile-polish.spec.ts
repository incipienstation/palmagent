import { test, expect, type Locator, type Page } from "@playwright/test";
import { tasks, usage, repos } from "../fixtures.mjs";
import { assertViewportLocked } from "./_helpers";

test.use({ serviceWorkers: "block" });

async function controlInbox(page: Page) {
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    const control = window as Window & { inboxSnapshots?: number; sendInboxFrame?: (frame: unknown) => void };
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        if (!String(url).includes("snapshots=1")) return;
        this.addEventListener("message", event => {
          if (JSON.parse(event.data).type === "tasks") control.inboxSnapshots = (control.inboxSnapshots ?? 0) + 1;
        });
        control.sendInboxFrame = frame => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
      }
    };
  });
}

async function sendInboxFrame(page: Page, frame: unknown) {
  await page.evaluate(value => {
    (window as Window & { sendInboxFrame: (frame: unknown) => void }).sendInboxFrame(value);
  }, frame);
}

async function expectTouchTarget(button: Locator): Promise<void> {
  // Trial action waits for visibility and a stable box without clicking the control.
  await button.click({ trial: true });
  const box = (await button.boundingBox())!;
  // Transformed DOMRects can report 43.999992 for a 44 CSS px target.
  // Keep this far below a layout subpixel so genuinely undersized controls still fail.
  const roundingTolerance = 0.0001;
  expect(box.width + roundingTolerance, "touch target width").toBeGreaterThanOrEqual(44);
  expect(box.height + roundingTolerance, "touch target height").toBeGreaterThanOrEqual(44);
}

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

test("usage ignores display snapshots, keeps Retry during automatic refresh, and recovers on reconnect", async ({ page }) => {
  await controlInbox(page);
  let requests = 0;
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/usage", async route => {
    requests++;
    if (requests === 2) await delayed;
    await route.fulfill(requests === 1 || requests === 3
      ? { status: 503, json: { error: "Temporarily unavailable" } }
      : { json: { usage } });
  });
  await page.goto("/#/usage");
  await expect(page.getByRole("alert")).toContainText("Couldn't load usage");
  await page.waitForFunction(() => (window as Window & { inboxSnapshots?: number }).inboxSnapshots === 1);
  await sendInboxFrame(page, { type: "tasks", tasks });
  await sendInboxFrame(page, { type: "tasks", tasks: tasks.map(task => ({ ...task, title: "Display edit", prs: [] })) });
  expect(requests).toBe(1);
  await sendInboxFrame(page, { type: "read-change", usage: true });
  await expect.poll(() => requests).toBe(2);
  await expect(page.getByRole("alert")).toContainText("Couldn't load usage");
  await expect(page.getByRole("button", { name: "Retry usage" })).toBeDisabled();
  await expect(page.getByRole("status", { name: "" }).filter({ hasText: "Retrying usage" })).toBeVisible();
  release();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("claude", { exact: true })).toBeVisible();

  await sendInboxFrame(page, { type: "read-change", usage: true });
  await expect.poll(() => requests).toBe(3);
  await expect(page.getByRole("alert")).toContainText("Couldn't load usage");
  await expect(page.getByText("claude", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry usage" }).click();
  await expect.poll(() => requests).toBe(4);
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForFunction(() => (window as Window & { inboxSnapshots?: number }).inboxSnapshots === 4);
  await expect.poll(() => requests).toBe(5);
});

test("routine history refresh is scoped and preserves its error during a slow recovery", async ({ page }) => {
  await controlInbox(page);
  let requests = 0;
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/routines/r-standup/runs", async route => {
    requests++;
    if (requests === 2) await delayed;
    await route.fulfill(requests === 1
      ? { status: 503, json: { error: "Temporarily unavailable" } }
      : { json: { runs: [] } });
  });
  await page.goto("/#/routines");
  await page.getByRole("button", { name: /History/ }).first().click();
  await expect(page.getByRole("alert")).toContainText("Couldn't load history");
  await page.waitForFunction(() => (window as Window & { inboxSnapshots?: number }).inboxSnapshots === 1);
  await sendInboxFrame(page, { type: "read-change", routineId: "r-triage" });
  expect(requests).toBe(1);
  await sendInboxFrame(page, { type: "read-change", routineId: "r-standup" });
  await expect.poll(() => requests).toBe(2);
  await expect(page.getByRole("alert")).toContainText("Couldn't load history");
  await expect(page.getByRole("button", { name: "Retry history" })).toBeDisabled();
  release();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("No runs yet.", { exact: true })).toBeVisible();
});

test("Settings controls remain reachable while scrolling on a narrow phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  await expectTouchTarget(settings);
  await settings.click();
  const header = page.locator('[data-slot="sheet-header"]');
  for (const name of ["Repository search paths", "Updates"]) {
    await page.getByRole("button", { name, exact: true }).click();
    const back = page.getByRole("button", { name: "Back to settings" });
    await expectTouchTarget(back);
    const headerTop = (await header.boundingBox())!.y;
    await expect(page.locator('[data-slot="settings-scroll"]:visible')).toHaveCount(1);
    await page.locator('[data-slot="settings-scroll"]:visible').evaluate(el => { el.scrollTop = el.scrollHeight; });
    expect((await header.boundingBox())!.y).toBeCloseTo(headerTop, 0);
    await assertViewportLocked(page);
    await back.click();
    await expect(page.getByRole("button", { name, exact: true })).toBeFocused();
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
