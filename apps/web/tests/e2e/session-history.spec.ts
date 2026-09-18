import { test, expect, type Page } from "@playwright/test";
import type { AgentEvent, TaskHistoryEvent } from "@palmagent/shared";
import { installScopedStream, open, send, viewport, expectBottom, type Harness } from "./_session-stream";

// Route-controlled delays and failures must reach Playwright rather than the PWA worker.
test.use({ serviceWorkers: "block" });

const taskId = "t-idle-rich";
function rows(from: number, to: number): TaskHistoryEvent[] {
  return Array.from({ length: to - from + 1 }, (_, i) => {
    const seq = from + i;
    const event: AgentEvent = { taskId, agent: "codex", ts: seq,
      kind: seq % 2 ? "assistant_text" : "tool_result",
      payload: seq % 2 ? { text: `History message ${seq}\n\n${"Variable height paragraph. ".repeat(seq % 7 + 1)}` } : { output: `Tool ${seq}` } };
    return { seq, event };
  });
}
async function deliver(page: Page, entries: TaskHistoryEvent[]) {
  await page.evaluate((entries) => {
    const harness = window as unknown as Harness;
    for (const { seq, event } of entries) harness.sendScopedFrame(event.taskId, { type: "event", event }, seq);
  }, entries);
}
async function recent(page: Page, mode = "verbose") {
  await open(page, taskId);
  await send(page, taskId, { type: "tasks", tasks: [], replayThrough: 2000, history: {
    after: 1800, before: 1801,
  } });
  await deliver(page, rows(1801, 2000));
  await expect(page.getByText(mode === "verbose" ? "tool_result: Tool 2000" : "History message 1999", { exact: true })).toBeVisible();
  await expectBottom(page);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pref:output-mode", "verbose"));
  await installScopedStream(page);
});

test("recent history and thousands of live events keep mounted rows bounded", async ({ page }) => {
  let olderRequests = 0;
  await page.route("**/history?*", (route) => { olderRequests++; return route.abort(); });
  await recent(page);
  expect(olderRequests).toBe(0);
  await expect(page.getByText("History message 1801", { exact: true })).toHaveCount(0);
  expect(await page.locator("[data-message-key]").count()).toBeLessThan(40);

  // One burst arrives before the browser can paint. Observe the mounted text to
  // verify that the UI publishes a batch instead of exposing each token/event.
  await page.evaluate(() => {
    let changes = 0;
    const observer = new MutationObserver(() => changes++);
    observer.observe(document.querySelector('[aria-label="Session transcript"]')!, { subtree: true, characterData: true });
    Object.assign(window, { textChanges: () => changes, stopObserving: () => observer.disconnect() });
  });
  await deliver(page, rows(2001, 6000));
  await expect(page.getByText("tool_result: Tool 6000", { exact: true })).toBeVisible();
  await expectBottom(page);
  expect(await page.locator("[data-message-key]").count()).toBeLessThan(40);
  const changes = await page.evaluate(() => {
    const metrics = window as unknown as { textChanges(): number; stopObserving(): void };
    metrics.stopObserving(); return metrics.textChanges();
  });
  expect(changes).toBeLessThan(10);
  expect(olderRequests).toBe(0);
});

test("prepending an older page preserves the visible message through simultaneous live output", async ({ page }, testInfo) => {
  let release!: () => void;
  let requested = 0;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/history?before=1801", async (route) => {
    requested++;
    await pending;
    await route.fulfill({ json: { events: rows(1601, 1800), before: 1601 } });
  });
  await recent(page);
  await viewport(page).evaluate((el) => { el.scrollTop = 0; });
  await expect.poll(() => requested).toBe(1);
  const anchor = page.locator('[data-message-key="1801"]');
  await expect(anchor).toBeVisible();
  const top = (await anchor.boundingBox())!.y;
  await expect(page.getByRole("status").filter({ hasText: "Loading earlier messages…" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("history-loading.png") });
  await deliver(page, rows(2001, 2020));
  release();
  await expect(page.getByText("Loading earlier messages…", { exact: true })).toHaveCount(0);
  // The loading indicator can disappear before Virtuoso commits the prepend.
  // Wait for its scroll adjustment before comparing the preserved anchor.
  await expect.poll(() => viewport(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(1000);
  await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - top)).toBeLessThanOrEqual(2);
  await expect(page.getByText("tool_result: Tool 2020", { exact: true })).toHaveCount(0);
  expect(requested).toBe(1);
});

test("a failed older page is retryable without replacing current history", async ({ page }) => {
  let attempts = 0;
  await page.route("**/history?before=1801", (route) => {
    attempts++;
    return attempts === 1 ? route.fulfill({ status: 503, json: { error: "History temporarily unavailable" } }) :
      route.fulfill({ json: { events: rows(1601, 1800), before: 1601 } });
  });
  await recent(page);
  await viewport(page).evaluate((el) => { el.scrollTop = 0; });
  await expect(page.getByRole("alert")).toHaveText("History temporarily unavailable");
  await expect(page.getByText("History message 1801", { exact: true })).toBeVisible();
  await viewport(page).evaluate((el) => { el.scrollTop = 100; });
  await viewport(page).evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(200);
  expect(attempts).toBe(1);
  await page.getByRole("button", { name: "Retry loading earlier messages" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect.poll(() => attempts).toBe(2);
  await expect.poll(() => viewport(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(1000);
});

test("scrolling away and back preserves a tool row's collapsed override", async ({ page }) => {
  await recent(page);
  const full = "Expanded tool output\n".repeat(80) + "Expansion survived remount";
  await send(page, taskId, { type: "event", event: { taskId, agent: "codex", ts: 2001, kind: "tool_result", payload: { output: full } } }, 2001);
  const row = page.locator('[data-message-key="2001"]');
  // Wait for the tall row to finish measuring; the collapse must preserve its
  // position even when it is the only row mounted at the bottom.
  await expectBottom(page);
  await page.waitForTimeout(800);
  // Verbose starts expanded. Retain a non-default override across unmounting.
  await row.getByRole("button").click();
  await expect(row.getByRole("button")).toHaveAttribute("aria-expanded", "false");
  // As with expectBottom, require the post-collapse layout to remain in view
  // across frames. A single visible frame can precede Virtuoso's measurement
  // correction and race the next synthetic scroll.
  await expect.poll(() => viewport(page).evaluate(async (el) => {
    for (let frame = 0; frame < 4; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const row = el.querySelector('[data-message-key="2001"]');
      const box = row?.getBoundingClientRect();
      const pane = el.getBoundingClientRect();
      if (!box || box.top < pane.top - 1 || box.bottom > pane.bottom + 1) return false;
    }
    return true;
  })).toBe(true);
  await viewport(page).evaluate((el) => { el.scrollTop = el.scrollHeight / 2; });
  await expect(row).toHaveCount(0);
  await viewport(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(row.getByRole("button")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText(/Expansion survived remount/)).toHaveCount(0);
});

test("loading the oldest page preserves the anchor as the oldest page completes", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let requested = false;
  await page.route("**/history?before=201", async (route) => {
    requested = true; await pending;
    await route.fulfill({ json: { events: rows(1, 200), before: null } });
  });
  await open(page, taskId);
  await send(page, taskId, { type: "tasks", tasks: [], replayThrough: 400, history: { after: 200, before: 201 } });
  await deliver(page, rows(201, 400));
  await expect(page.getByText("tool_result: Tool 400", { exact: true })).toBeVisible();
  await expectBottom(page);
  await viewport(page).evaluate((el) => { el.scrollTop = 0; });
  await expect.poll(() => requested).toBe(true);
  const anchor = page.locator('[data-message-key="201"]');
  const top = (await anchor.boundingBox())!.y;
  release();
  await expect(page.getByRole("status").filter({ hasText: "Beginning of conversation" })).toHaveCount(1);
  await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - top)).toBeLessThanOrEqual(2);
});

test("compact mode automatically skips consecutive pages of hidden status events", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pref:output-mode", "compact"));
  const cursors: string[] = [];
  await page.route("**/history?*", (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("before")!;
    cursors.push(cursor);
    return route.fulfill({ json: cursor === "201" ? {
      events: rows(101, 200).map(({ seq, event }) => ({ seq, event: {
        ...event, kind: "status", payload: { subtype: "reasoning" },
      } })), before: 101,
    } : { events: rows(1, 100), before: null } });
  });
  await open(page, taskId);
  await send(page, taskId, { type: "tasks", tasks: [], replayThrough: 202, history: { after: 200, before: 201 } });
  for (const seq of [201, 202]) await send(page, taskId, { type: "event", event: {
    taskId, agent: "codex", ts: seq, kind: "status", payload: { subtype: "reasoning" },
  } }, seq);
  await expect(page.getByRole("button", { name: "Load earlier messages", exact: true })).toHaveCount(0);
  await expect(page.getByText("History message 99", { exact: true })).toBeVisible();
  expect(cursors).toEqual(["201", "101"]);
});

test("expanded activity virtualizes its individual tool records and retains disclosure state", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pref:output-mode", "default"));
  await open(page, taskId);
  await send(page, taskId, { type: "tasks", tasks: [], replayThrough: 1000 });
  const entries: TaskHistoryEvent[] = Array.from({ length: 1000 }, (_, index) => {
    const seq = index + 1;
    return { seq, event: { taskId, agent: "codex", ts: seq, kind: seq % 2 ? "tool_call" : "tool_result",
      payload: seq % 2 ? { id: `tool-${seq}`, name: "bash", command: `echo ${seq}` } : { output: `Activity record ${seq}` } } };
  });
  await deliver(page, entries);
  const disclosure = page.getByRole("button", { name: "Commands · 500 tools", exact: true });
  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("tool_result: Activity record 2", { exact: true })).toBeVisible();
  expect(await page.locator("[data-row-key]").count()).toBeLessThan(40);
  await viewport(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(page.getByText("tool_result: Activity record 1000", { exact: true })).toBeVisible();
  expect(await page.locator("[data-row-key]").count()).toBeLessThan(40);
  await expect(disclosure).toHaveCount(0);
  await viewport(page).evaluate((el) => { el.scrollTop = 0; });
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
});

for (const mode of ["compact", "default"]) {
  test(`${mode}: loading earlier activity preserves the visible message`, async ({ page }) => {
    await page.addInitScript((mode) => localStorage.setItem("pref:output-mode", mode), mode);
    let release!: () => void;
    let requested = false;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/history?before=1801", async (route) => {
      requested = true; await pending;
      await route.fulfill({ json: { events: rows(1601, 1800), before: 1601 } });
    });
    await recent(page, mode);
    await viewport(page).evaluate((el) => { el.scrollTop = 0; });
    await expect.poll(() => requested).toBe(true);
    const anchor = page.locator('[data-message-key="1801"]');
    await expect(anchor).toBeVisible();
    const top = (await anchor.boundingBox())!.y;
    await deliver(page, rows(2001, 2020));
    release();
    await expect(page.getByText("Loading earlier messages…", { exact: true })).toHaveCount(0);
    await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - top)).toBeLessThanOrEqual(2);
    expect(await viewport(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(1000);
  });
}

test("near-top scrolling prefetches the next page before reaching the edge", async ({ page }) => {
  let requested = 0;
  await page.route("**/history?before=1801", async (route) => {
    requested++;
    await route.fulfill({ json: { events: rows(1601, 1800), before: 1601 } });
  });
  await recent(page);
  await expect(page.getByRole("button", { name: "Load earlier messages", exact: true })).toHaveCount(0);
  await viewport(page).evaluate((el) => { el.scrollTop = 200; });
  await expect.poll(() => requested).toBe(1);
  await expect.poll(() => viewport(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(1000);
});

test("short history fills the viewport automatically and stops at the beginning", async ({ page }, testInfo) => {
  const cursors: string[] = [];
  await page.route("**/history?*", (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("before")!;
    cursors.push(cursor);
    return route.fulfill({ json: cursor === "5" ? { events: rows(3, 4), before: 3 } :
      { events: rows(1, 2), before: null } });
  });
  await open(page, taskId);
  await send(page, taskId, { type: "tasks", tasks: [], replayThrough: 6, history: { after: 4, before: 5 } });
  await deliver(page, rows(5, 6));
  await expect(page.getByRole("status").filter({ hasText: "Beginning of conversation" })).toHaveCount(1);
  await viewport(page).evaluate((el) => { el.scrollTop = 0; });
  await expect(page.getByText("History message 1", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("history-beginning.png") });
  expect(cursors).toEqual(["5", "3"]);
});


test("returning to a conversation keeps messages and resumes only missed events", async ({ page }) => {
  await recent(page);
  await page.evaluate(() => { location.hash = "/"; });
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  await page.evaluate(() => { location.hash = "/task/t-idle-rich"; });
  await expect(page.getByText("tool_result: Tool 2000", { exact: true })).toBeVisible();
  const urls = await page.evaluate(() => (window as unknown as Harness).scopedUrls);
  expect(new URL(urls.at(-1)!).searchParams.get("lastEventId")).toBe("2000");
  await deliver(page, rows(2000, 2002));
  await expect(page.getByText("tool_result: Tool 2002", { exact: true })).toBeVisible();
  await expect(page.locator('[data-message-key="2000"]')).toHaveCount(1);
});
