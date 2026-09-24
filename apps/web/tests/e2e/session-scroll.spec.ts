import { test, expect } from "@playwright/test";
import type { TaskHistoryEvent } from "@palmagent/shared";
import { installScopedStream, open, send, event, viewport, expectBottom, type Harness } from "./_session-stream";

test.use({ serviceWorkers: "block" });
test.beforeEach(async ({ page }) => installScopedStream(page));

function savedRows(): TaskHistoryEvent[] {
  const row = (seq: number, kind: "assistant_text" | "tool_result", text: string): TaskHistoryEvent => ({
    seq,
    event: { taskId: "t-idle-rich", agent: "codex", ts: seq, kind,
      payload: kind === "assistant_text" ? { text } : { output: text } },
  });
  return [
    row(1, "assistant_text", "Earlier history\n\n".repeat(100)),
    row(2, "tool_result", "Middle marker"),
    row(3, "assistant_text", "Middle history\n\n".repeat(100)),
    row(4, "tool_result", "Latest marker"),
    row(5, "assistant_text", "Latest history"),
  ];
}

test("delayed REST history paints at the bottom, then live output preserves follow and reading position", async ({ page }) => {
  let release!: () => void;
  let requested = false;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/tasks/t-idle-rich/history*", async route => {
    if (new URL(route.request().url()).pathname !== "/api/tasks/t-idle-rich/history") return route.fallback();
    requested = true;
    await pending;
    await route.fulfill({ json: { events: savedRows(), before: null, cursor: 5 } });
  });
  await page.goto("/#/task/t-idle-rich");
  await expect(page.getByText("Loading history…")).toBeVisible();
  expect(requested).toBe(true);

  // Inspect every painted frame once history becomes visible, rather than
  // accepting a view which eventually reaches the bottom after scrolling.
  await page.evaluate(() => {
    const samples: number[] = [];
    Object.assign(window, { initialScrollSamples: samples });
    const sample = () => {
      const el = document.querySelector("[data-radix-scroll-area-viewport]");
      if (el?.textContent?.includes("Latest history") &&
          getComputedStyle(el.querySelector('[data-testid="virtuoso-item-list"]') ?? el).visibility === "visible") {
        samples.push(el.scrollHeight - el.clientHeight - el.scrollTop);
      }
      if (samples.length < 5) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  release();
  await expect.poll(() => page.evaluate(id => (window as unknown as Harness).hasScopedStream(id), "t-idle-rich")).toBe(true);
  await send(page, "t-idle-rich", { type: "tasks", tasks: [], historyThrough: 5 });
  await expect(page.getByText("Loading history…")).toHaveCount(0);
  await expect(page.getByText(/Middle history/).first()).toBeVisible();
  await expect(page.getByText("Latest history", { exact: true })).toBeVisible();
  await viewport(page).evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expectBottom(page);
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { initialScrollSamples: number[] }).initialScrollSamples.length)).toBe(5);
  const samples = await page.evaluate(() =>
    (window as unknown as { initialScrollSamples: number[] }).initialScrollSamples);
  expect(samples.every((gap) => gap <= 1), `first visible frames: ${samples}`).toBe(true);

  await event(page, "t-idle-rich", 6, "\n\nLive update\n\n".repeat(20));
  await expect(page.getByText(/Live update/)).toHaveCount(20);
  await expectBottom(page);
  await viewport(page).evaluate(el => { el.scrollTop = 100; el.dispatchEvent(new Event("scroll")); });
  await event(page, "t-idle-rich", 7, "\n\nWhile reading");
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await viewport(page).evaluate(el => el.scrollTop)).toBe(100);
  await viewport(page).evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(page.getByText(/While reading/)).toBeVisible();
  await viewport(page).evaluate(el => { el.scrollTop = 100; el.dispatchEvent(new Event("scroll")); });

  // Foreground reconnects recover the durable gap over REST before resuming live output.
  let catchupAfter = -1;
  let catchupReads = 0;
  let catchupFinished = false;
  await page.route(/\/api\/tasks\/t-idle-rich\/history\/changes(?:\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    catchupAfter = Number(url.searchParams.get("after"));
    catchupReads++;
    await route.fulfill({ json: {
      events: [{ seq: 8, event: { taskId: "t-idle-rich", agent: "codex", ts: 8, kind: "assistant_text", payload: { text: "\n\nReconnected update" } } }],
      after: catchupAfter, through: Number(url.searchParams.get("through")), nextAfter: null,
    } });
    catchupFinished = true;
  });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await send(page, "t-idle-rich", { type: "tasks", tasks: [], historyThrough: 8 });
  await expect.poll(() => catchupReads).toBe(1);
  expect(catchupAfter).toBe(7);
  await expect.poll(() => catchupFinished).toBe(true);
  await event(page, "t-idle-rich", 7, "DUPLICATE");
  await event(page, "t-idle-rich", 9, "\n\nNew live update");
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await viewport(page).evaluate(el => el.scrollTop)).toBe(100);
  await expect(page.getByText(/DUPLICATE/)).toHaveCount(0);
  await viewport(page).evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(page.getByText(/Reconnected update/)).toBeVisible();
  await expect(page.getByText(/New live update/)).toBeVisible();

  // A direct session switch must not inherit the previous session's scroll lock.
  await page.route("**/api/tasks/t-run/history*", route => route.fulfill({ json: { events: [], before: null, cursor: 0 } }));
  await page.evaluate(() => { location.hash = "/task/t-run"; });
  await expect.poll(() => page.evaluate(() => (window as unknown as Harness).hasScopedStream("t-run"))).toBe(true);
  await send(page, "t-run", { type: "tasks", tasks: [], historyThrough: 0 });
  await expect(page.getByText(/Earlier history/)).toHaveCount(0);
  await event(page, "t-run", 1, "Other session\n\n".repeat(100));
  await expectBottom(page);
});

test("REST snapshot gaps are fetched before live output and empty history starts at zero", async ({ page }) => {
  let release!: () => void;
  let reads = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/tasks/t-idle-rich/history*", async route => {
    if (new URL(route.request().url()).pathname !== "/api/tasks/t-idle-rich/history") return route.fallback();
    reads++;
    await pending;
    const row: TaskHistoryEvent = { seq: 1, event: {
      taskId: "t-idle-rich", agent: "codex", ts: 1, kind: "assistant_text", payload: { text: "Saved history" },
    } };
    await route.fulfill({ json: { events: [row], before: null, cursor: 1 } });
  });
  await page.goto("/#/task/t-idle-rich");
  await expect(page.getByText("Loading history…")).toBeVisible();
  release();
  await expect.poll(() => page.evaluate(id => (window as unknown as Harness).hasScopedStream(id), "t-idle-rich")).toBe(true);
  await page.route("**/api/tasks/t-idle-rich/history/changes?after=1&through=2*", (route) => route.fulfill({ json: {
    events: [{ seq: 2, event: { taskId: "t-idle-rich", agent: "codex", ts: 2, kind: "assistant_text", payload: { text: "First delta" } } }],
    after: 1, through: 2, nextAfter: null,
  } }));
  const urls = await page.evaluate(() => (window as unknown as Harness).scopedUrls);
  expect(new URL(urls.at(-1)!).searchParams.has("lastEventId")).toBe(false);
  await send(page, "t-idle-rich", { type: "tasks", tasks: [], historyThrough: 2 });
  await expect(page.getByText(/First delta/)).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.route("**/api/tasks/t-idle-rich/history/changes?after=2&through=3*", (route) => route.fulfill({ json: {
    events: [{ seq: 3, event: { taskId: "t-idle-rich", agent: "codex", ts: 3, kind: "assistant_text", payload: { text: "Second delta" } } }],
    after: 2, through: 3, nextAfter: null,
  } }));
  await send(page, "t-idle-rich", { type: "tasks", tasks: [], historyThrough: 3 });
  await expect(page.getByText(/Second delta/)).toBeVisible();
  await event(page, "t-idle-rich", 2, "DUPLICATE");
  await expect(page.getByLabel("Session transcript")).toContainText("Saved historyFirst deltaSecond delta");
  await expect(page.getByText(/DUPLICATE/)).toHaveCount(0);
  expect(reads).toBe(1);

  await page.route("**/api/tasks/t-run/history*", route => route.fulfill({ json: { events: [], before: null, cursor: 0 } }));
  await page.evaluate(() => { location.hash = "/task/t-run"; });
  await expect.poll(() => page.evaluate(() => (window as unknown as Harness).hasScopedStream("t-run"))).toBe(true);
  const currentUrls = await page.evaluate(() => (window as unknown as Harness).scopedUrls);
  expect(new URL(currentUrls.at(-1)!).searchParams.has("lastEventId")).toBe(false);
  await send(page, "t-run", { type: "tasks", tasks: [], historyThrough: 0 });
  await event(page, "t-run", 1, "First live message");
  await expect(page.getByText("First live message")).toBeVisible();
});

test("viewport resizing follows the bottom without moving a reader in older history", async ({ page }) => {
  await open(page, "t-idle-rich");
  await send(page, "t-idle-rich", { type: "tasks", tasks: [], historyThrough: 0 });
  await event(page, "t-idle-rich", 1, "Long session history\n\n".repeat(200));
  await expectBottom(page);
  await page.setViewportSize({ width: 360, height: 650 });
  await expectBottom(page);
  await viewport(page).evaluate(el => new Promise<void>(resolve => {
    el.addEventListener("scroll", () => resolve(), { once: true });
    el.scrollTop = 100;
  }));
  await expect.poll(() => viewport(page).evaluate(el => el.scrollTop)).toBe(100);
  await page.setViewportSize({ width: 360, height: 600 });
  await event(page, "t-idle-rich", 2, "A new streamed line\n\n");
  await expect(page.getByText(/A new streamed line/)).toHaveCount(1);
  expect(await viewport(page).evaluate(el => el.scrollTop)).toBe(100);
});
