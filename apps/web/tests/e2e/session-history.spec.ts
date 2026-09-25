import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { AgentEvent, TaskHistoryEvent } from "@palmagent/shared";
import { installScopedStream, open, send, viewport, expectBottom, type Harness } from "./_session-stream";

// Route-controlled delays and failures must reach Playwright rather than the PWA worker.
test.use({ serviceWorkers: "block" });

const taskId = "t-idle-rich";
const imageId = "93db3f15-c90f-40b4-a28c-b0fd573a6d9f";
const tallImage = readFileSync(new URL("./image-rendering.spec.ts-snapshots/image-preview-mobile-linux.png", import.meta.url));
function rows(from: number, to: number): TaskHistoryEvent[] {
  return Array.from({ length: to - from + 1 }, (_, i) => {
    const seq = from + i;
    const event: AgentEvent = { taskId, agent: "codex", ts: seq,
      kind: seq % 2 ? "assistant_text" : "tool_result",
      payload: seq % 2 ? { text: `History message ${seq}\n\n${"Variable height paragraph. ".repeat(seq % 7 + 1)}` } : { output: `Tool ${seq}` } };
    return { seq, event };
  });
}
function toolActivityRows(from: number, to: number): TaskHistoryEvent[] {
  return Array.from({ length: to - from + 1 }, (_, i) => {
    const seq = from + i;
    const slot = i % 20;
    const kind: AgentEvent["kind"] = slot === 0 ? "tool_call" : slot === 1 ? "tool_result" : "assistant_text";
    const payload = kind === "tool_call" ? { id: `tool-${seq}`, name: "bash", command: `echo ${seq}` }
      : kind === "tool_result" ? { tool_use_id: `tool-${seq - 1}`, output: `Tool ${seq}` }
      : { text: `History paragraph ${seq}. `.repeat(18) };
    return { seq, event: { taskId, agent: "codex", ts: seq, kind, payload } };
  });
}
function longMarkdownRows(from: number, to: number): TaskHistoryEvent[] {
  return Array.from({ length: to - from + 1 }, (_, i) => {
    const seq = from + i;
    const event: AgentEvent = seq % 2 ? {
      taskId, agent: "codex", ts: seq, kind: "assistant_text",
      payload: { text: `## History entry ${seq}\n\n${"Paragraph with **formatted text** and a [link](https://example.invalid).\n\n".repeat(500)}` },
    } : { taskId, agent: "codex", ts: seq, kind: "tool_result", payload: { output: `Tool ${seq}` } };
    return { seq, event };
  });
}
async function deliver(page: Page, entries: TaskHistoryEvent[]) {
  await page.evaluate((entries) => {
    const harness = window as unknown as Harness;
    for (const { seq, event } of entries) harness.sendScopedFrame(event.taskId, { type: "event", event }, seq);
  }, entries);
}
async function installLatestHistory(page: Page, entries: TaskHistoryEvent[], before: number | null, cursor: number) {
  let reads = 0;
  await page.route(new RegExp(`/api/tasks/${taskId}/history(?:\\?.*)?$`), async (route) => {
    if (new URL(route.request().url()).searchParams.has("before")) return route.fallback();
    reads++;
    await route.fulfill({ json: { events: entries, before, cursor } });
  });
  return () => reads;
}
async function recent(page: Page, mode = "verbose") {
  const reads = await installLatestHistory(page, rows(1801, 2000), 1801, 2000);
  await open(page, taskId, { serverHistory: true });
  await send(page, taskId, { type: "tasks", tasks: [], historyThrough: 2000 });
  await expect(page.getByText(mode === "verbose" ? "tool_result: Tool 2000" : "History message 1999", { exact: true })).toBeVisible();
  await expectBottom(page);
  return reads;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pref:output-mode", "verbose"));
  await installScopedStream(page);
});

test("recent history and thousands of live events keep mounted rows bounded", async ({ page }) => {
  let olderRequests = 0;
  await page.route("**/history?*", (route) => { olderRequests++; return route.abort(); });
  const latestRequests = await recent(page);
  expect(latestRequests()).toBe(1);
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
  await page.route("**/history?before=1801*", async (route) => {
    requested++;
    await pending;
    await route.fulfill({ json: { events: rows(1601, 1800), before: 1601, cursor: 2000 } });
  });
  await recent(page);
  await viewport(page).evaluate((el) => { el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })); el.scrollTop = 0; });
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

test("prepending older history keeps a cross-page Activity row mounted", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pref:output-mode", "compact"));
  let release!: () => void;
  let requested = false;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route(new RegExp(`/api/tasks/${taskId}/history(?:\\?.*)?$`), async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("before")) {
      requested = true;
      await pending;
      await route.fulfill({ json: { events: toolActivityRows(1601, 1800), before: 1601, cursor: 2000 } });
      return;
    }
    await route.fulfill({ json: { events: toolActivityRows(1801, 2000), before: 1801, cursor: 2000 } });
  });
  await open(page, taskId, { serverHistory: true });
  await send(page, taskId, { type: "tasks", tasks: [], historyThrough: 2000 });
  const activity = page.locator('[data-row-key="activity-1801"]');
  await expect(page.getByText(/History paragraph 2000/)).toBeVisible();
  await viewport(page).evaluate((el) => { el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })); el.scrollTop = 0; });
  await expect(activity).toBeVisible();
  await expect.poll(() => requested).toBe(true);
  const top = (await activity.boundingBox())!.y;
  await activity.evaluate((element) => Object.assign(window, { savedHistoryActivity: element }));

  release();
  await expect(page.getByRole("button", { name: "Activity · 20 tools", exact: true })).toBeVisible();
  const restored = await page.evaluate(() => {
    const element = (window as unknown as { savedHistoryActivity: HTMLElement }).savedHistoryActivity;
    return { connected: element.isConnected, key: element.dataset.rowKey, top: element.getBoundingClientRect().y };
  });
  expect(restored.connected).toBe(true);
  expect(restored.key).toBe("activity-1801");
  expect(Math.abs(restored.top - top)).toBeLessThanOrEqual(2);
});

test("fast upward scrolling formats long Markdown before it reaches the viewport", async ({ page }) => {
  await page.route(new RegExp(`/api/tasks/${taskId}/history(?:\\?.*)?$`), route => route.fulfill({
    json: { events: longMarkdownRows(1801, 1808), before: null, cursor: 1808 },
  }));
  await open(page, taskId, { serverHistory: true });
  await send(page, taskId, { type: "tasks", tasks: [], historyThrough: 1808 });
  await expectBottom(page);
  await expect(page.getByText("tool_result: Tool 1808", { exact: true })).toBeVisible();
  const target = page.locator('[data-message-key="1801"]');
  await expect(target).toHaveCount(0);
  const samples = await page.evaluate(() => new Promise<Array<{ formatted: boolean; height: number }>>((resolve) => {
    const viewport = document.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]")!;
    const samples: Array<{ formatted: boolean; height: number }> = [];
    const capture = () => {
      const row = viewport.querySelector<HTMLElement>('[data-message-key="1801"]');
      if (row) {
        const rect = row.getBoundingClientRect();
        const pane = viewport.getBoundingClientRect();
        if (rect.bottom > pane.top && rect.top < pane.bottom) {
          samples.push({ formatted: !!row.querySelector("h2"), height: rect.height });
        }
      }
      if (viewport.scrollTop > 0) {
        viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
        viewport.scrollTop = Math.max(0, viewport.scrollTop - 300);
      }
      if (viewport.scrollTop > 0 || samples.length < 60) requestAnimationFrame(capture);
      else resolve(samples);
    };
    requestAnimationFrame(capture);
  }));
  await expect(page.getByRole("heading", { name: "History entry 1801", exact: true })).toBeVisible();
  expect(samples.length).toBeGreaterThan(0);
  expect(samples.every(sample => sample.formatted)).toBe(true);
  expect(samples.some(sample => sample.formatted)).toBe(true);
});

for (const scenario of [
  { name: "slow mobile wheel", distance: 180, width: 360, mode: "verbose", touch: false },
  { name: "fast mobile wheel", distance: 600, width: 360, mode: "verbose", touch: false },
  { name: "compact mobile touch", distance: 600, width: 360, mode: "compact", touch: true },
  { name: "compact desktop wheel", distance: 600, width: 1280, mode: "compact", touch: false },
]) test.describe(scenario.name, () => {
  test.use({ viewport: { width: scenario.width, height: 780 }, isMobile: scenario.width < 600, hasTouch: scenario.width < 600 });
  test("upward scrolling keeps mixed-height history painted", async ({ page }, testInfo) => {
    const { distance } = scenario;
    await page.addInitScript(mode => localStorage.setItem("pref:output-mode", mode), scenario.mode);
    const entries = rows(1801, 2000).map(entry => entry.seq % 2 === 0 ? entry : ({ ...entry, event: {
      ...entry.event, kind: "assistant_text" as const,
      payload: { text: `## Entry ${entry.seq}\n\n${"A paragraph of **formatted text** with varying height.\n\n".repeat(entry.seq % 5 === 0 ? 500 : 80 + (entry.seq % 7) * 25)}` },
    } }));
    await installLatestHistory(page, entries, null, 2000);
    await open(page, taskId, { serverHistory: true });
    await send(page, taskId, { type: "tasks", tasks: [], historyThrough: 2000 });
    await expectBottom(page);
    await page.evaluate(() => {
      const pane = document.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]")!;
      const samples: Array<{ blank: boolean; raw: boolean; jump: number; scrollTop: number; keys: string[] }> = [];
      let last = new Map<string, number>();
      let active = true;
      const capture = () => {
        const bounds = pane.getBoundingClientRect();
        const visible = [...pane.querySelectorAll<HTMLElement>("[data-row-key]")].map(row => ({
          key: row.dataset.rowKey!, rect: row.getBoundingClientRect(), formatted: !row.dataset.messageKey || !!row.querySelector('h2') || Number(row.dataset.messageKey) % 2 === 0,
        })).filter(({ rect }) => rect.bottom > bounds.top && rect.top < bounds.bottom);
        const jump = Math.min(0, ...visible.flatMap(({ key, rect }) => last.has(key) ? [rect.top - last.get(key)!] : []));
        samples.push({ blank: visible.length === 0, raw: visible.some(row => !row.formatted), jump, scrollTop: pane.scrollTop, keys: visible.map(row => row.key) });
        last = new Map(visible.map(({ key, rect }) => [key, rect.top]));
        if (active) requestAnimationFrame(capture);
      };
      Object.assign(window, { stopScrollCapture: () => { active = false; return samples; } });
      requestAnimationFrame(capture);
    });
    const box = (await viewport(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    if (scenario.touch) {
      const cdp = await page.context().newCDPSession(page);
      for (let i = 0; i < 45; i++) {
        const x = box.x + box.width / 2, y = box.y + 40;
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        for (let step = 1; step <= 6; step++) {
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + (box.height - 80) * step / 6 }] });
          await page.waitForTimeout(20);
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      }
      await cdp.detach();
    } else {
      for (let i = 0; i < 60; i++) {
        await page.mouse.wheel(0, -distance);
        await page.waitForTimeout(20);
      }
    }
    const samples = await page.evaluate(() => (window as unknown as {
      stopScrollCapture(): Array<{ blank: boolean; raw: boolean; jump: number; scrollTop: number; keys: string[] }>;
    }).stopScrollCapture());
    await testInfo.attach("upward-scroll-frames", { body: JSON.stringify(samples), contentType: "application/json" });
    console.log(JSON.stringify({ scenario: scenario.name, frames: samples.length, blank: samples.filter(sample => sample.blank).length, raw: samples.filter(sample => sample.raw).length, worstJump: Math.min(...samples.map(sample => sample.jump)), distinct: new Set(samples.flatMap(sample => sample.keys)).size, firstTop: samples[0].scrollTop, lastTop: samples.at(-1)?.scrollTop }));
    expect(new Set(samples.flatMap(sample => sample.keys)).size).toBeGreaterThan(2);
    expect(samples.filter(sample => sample.raw), "Visible messages must retain their formatted content").toEqual([]);
    expect(samples.filter(sample => sample.blank), "No frame should expose an empty transcript").toEqual([]);
    expect(Math.min(...samples.map(sample => sample.jump)), "Upward scrolling must not move visible content backward").toBeGreaterThanOrEqual(-2);
  });
});

test("loading an older attachment keeps the reader's visible message in place", async ({ page }) => {
  let requested = 0, release!: () => void;
  const imageGate = new Promise<void>(resolve => { release = resolve; });
  const entries: TaskHistoryEvent[] = [
    { seq: 1801, event: { taskId, agent: "codex", ts: 1801, kind: "status", payload: { subtype: "followup", text: "Review this image", attachments: [
      { id: imageId, mediaType: "image/png", size: tallImage.length, width: 360, height: 780 },
    ] } } },
    { seq: 1802, event: { taskId, agent: "codex", ts: 1802, kind: "assistant_text", payload: { text: "Keep this message in view." } } },
    { seq: 1803, event: { taskId, agent: "codex", ts: 1803, kind: "tool_result", payload: { output: "End of history" } } },
  ];
  await page.route(new RegExp(`/api/tasks/${taskId}/history(?:\\?.*)?$`), route => route.fulfill({
    json: { events: entries, before: null, cursor: 1803 },
  }));
  await page.route(`**/api/tasks/${taskId}/attachments/${imageId}`, async route => {
    requested++;
    await imageGate;
    await route.fulfill({ contentType: "image/png", body: tallImage });
  });
  await open(page, taskId, { serverHistory: true });
  await send(page, taskId, { type: "tasks", tasks: [], historyThrough: 1803 });
  await expectBottom(page);

  try {
    await viewport(page).evaluate(el => { el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })); el.scrollTop = 0; });
    const anchor = page.locator('[data-message-key="1802"]');
    await expect(anchor).toBeVisible();
    await expect.poll(() => requested).toBe(1);
    const before = (await anchor.boundingBox())!.y;
    release();
    await expect.poll(() => page.getByRole("img", { name: "Attached image 1" }).evaluate(img => (img as HTMLImageElement).naturalWidth)).toBe(360);
    const after = (await anchor.boundingBox())!.y;
    expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
  } finally {
    release();
  }
});

test("a failed older page is retryable without replacing current history", async ({ page }) => {
  let attempts = 0;
  await page.route("**/history?before=1801*", (route) => {
    attempts++;
    return attempts === 1 ? route.fulfill({ status: 503, json: { error: "History temporarily unavailable" } }) :
      route.fulfill({ json: { events: rows(1601, 1800), before: 1601, cursor: 2000 } });
  });
  await recent(page);
  await viewport(page).evaluate((el) => { el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })); el.scrollTop = 0; });
  await expect(page.getByRole("alert")).toHaveText("History temporarily unavailable");
  await expect(page.getByText("History message 1801", { exact: true })).toBeVisible();
  await viewport(page).evaluate((el) => { el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })); el.scrollTop = 100; });
  await viewport(page).evaluate((el) => { el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })); el.scrollTop = 0; });
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
  await viewport(page).evaluate((el) => { el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })); el.scrollTop = el.scrollHeight / 2; });
  await expect(row).toHaveCount(0);
  await viewport(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(row.getByRole("button")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText(/Expansion survived remount/)).toHaveCount(0);
});

test("loading the oldest page preserves the anchor as the oldest page completes", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let requested = false;
  await page.route("**/history?before=201*", async (route) => {
    requested = true; await pending;
    await route.fulfill({ json: { events: rows(1, 200), before: null, cursor: 400 } });
  });
  await installLatestHistory(page, rows(201, 400), 201, 400);
  await open(page, taskId, { serverHistory: true });
  await send(page, taskId, { type: "tasks", tasks: [], historyThrough: 400 });
  await expect(page.getByText("tool_result: Tool 400", { exact: true })).toBeVisible();
  await expectBottom(page);
  await viewport(page).evaluate((el) => { el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })); el.scrollTop = 0; });
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
  await page.route("**/history*", (route) => {
    const before = new URL(route.request().url()).searchParams.get("before");
    const cursor = before ?? "latest";
    cursors.push(cursor);
    return route.fulfill({ json: cursor === "latest" ? {
      events: rows(201, 400).map(({ seq, event }) => ({ seq, event: { ...event, kind: "status", payload: { subtype: "reasoning" } } })), before: 201, cursor: 400,
    } : cursor === "201" ? {
      events: rows(101, 200).map(({ seq, event }) => ({ seq, event: {
        ...event, kind: "status", payload: { subtype: "reasoning" },
      } })), before: 101,
      cursor: 400,
    } : { events: rows(1, 100), before: null, cursor: 400 } });
  });
  await open(page, taskId, { serverHistory: true });
  await send(page, taskId, { type: "tasks", tasks: [], historyThrough: 400 });
  await expect(page.getByRole("button", { name: "Load earlier messages", exact: true })).toHaveCount(0);
  await expect(page.getByText("History message 99", { exact: true })).toBeVisible();
  expect(cursors).toEqual(["latest", "201", "101"]);
});

test("expanded activity virtualizes its individual tool records and retains disclosure state", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pref:output-mode", "default"));
  await installLatestHistory(page, [], null, 0);
  await open(page, taskId, { serverHistory: true });
  await send(page, taskId, { type: "tasks", tasks: [], historyThrough: 0 });
  const entries: TaskHistoryEvent[] = Array.from({ length: 1000 }, (_, index) => {
    const seq = index + 1;
    return { seq, event: { taskId, agent: "codex", ts: seq, kind: seq % 2 ? "tool_call" : "tool_result",
      payload: seq % 2 ? { id: `tool-${seq}`, name: "bash", command: `echo ${seq}` } : { output: `Activity record ${seq}` } } };
  });
  await deliver(page, entries);
  const disclosure = page.getByRole("button", { name: "Activity · 500 tools", exact: true });
  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("tool_result: Activity record 2", { exact: true })).toBeVisible();
  expect(await page.locator("[data-row-key]").count()).toBeLessThan(40);
  await viewport(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(page.getByText("tool_result: Activity record 1000", { exact: true })).toBeVisible();
  expect(await page.locator("[data-row-key]").count()).toBeLessThan(40);
  await expect(disclosure).toHaveCount(0);
  await viewport(page).evaluate((el) => { el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })); el.scrollTop = 0; });
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
});

for (const mode of ["compact"]) {
  test(`${mode}: loading earlier activity preserves the visible message`, async ({ page }) => {
    await page.addInitScript((mode) => localStorage.setItem("pref:output-mode", mode), mode);
    let release!: () => void;
    let requested = false;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/history?before=1801*", async (route) => {
      requested = true; await pending;
      await route.fulfill({ json: { events: rows(1601, 1800), before: 1601, cursor: 2000 } });
    });
    await recent(page, mode);
    await viewport(page).evaluate((el) => { el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })); el.scrollTop = 0; });
    await expect.poll(() => requested).toBe(true);
    const anchor = page.locator('[data-message-key="1801"]');
    await expect(anchor).toBeVisible();
    const top = (await anchor.boundingBox())!.y;
    await deliver(page, rows(2001, 2020));
    release();
    await expect(page.getByText("Loading earlier messages…", { exact: true })).toHaveCount(0);
    // Loading can settle before Virtuoso commits the prepended page.
    await expect.poll(() => viewport(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(1000);
    await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - top)).toBeLessThanOrEqual(2);
  });
}

test("near-top scrolling prefetches the next page before reaching the edge", async ({ page }) => {
  let requested = 0;
  await page.route("**/history?before=1801*", async (route) => {
    requested++;
    await route.fulfill({ json: { events: rows(1601, 1800), before: 1601, cursor: 2000 } });
  });
  await recent(page);
  await expect(page.getByRole("button", { name: "Load earlier messages", exact: true })).toHaveCount(0);
  await viewport(page).evaluate((el) => { el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })); el.scrollTop = 200; });
  await expect.poll(() => requested).toBe(1);
  await expect.poll(() => viewport(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(1000);
});

test("short history fills the viewport automatically and stops at the beginning", async ({ page }, testInfo) => {
  const cursors: string[] = [];
  await page.route("**/history*", (route) => {
    const before = new URL(route.request().url()).searchParams.get("before");
    const cursor = before ?? "latest";
    cursors.push(cursor);
    return route.fulfill({ json: cursor === "latest" ? { events: rows(5, 6), before: 5, cursor: 6 } :
      cursor === "5" ? { events: rows(3, 4), before: 3, cursor: 6 } : { events: rows(1, 2), before: null, cursor: 6 } });
  });
  await open(page, taskId, { serverHistory: true });
  await send(page, taskId, { type: "tasks", tasks: [], historyThrough: 6 });
  await expect(page.getByRole("status").filter({ hasText: "Beginning of conversation" })).toHaveCount(1);
  await viewport(page).evaluate((el) => { el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })); el.scrollTop = 0; });
  await expect(page.getByText("History message 1", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("history-beginning.png") });
  expect(cursors).toEqual(["latest", "5", "3"]);
});


test("returning to a conversation keeps messages and resumes only missed events", async ({ page }) => {
  const latestRequests = await recent(page);
  await page.evaluate(() => { location.hash = "/"; });
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  await page.evaluate(() => { location.hash = "/task/t-idle-rich"; });
  await expect(page.getByText("tool_result: Tool 2000", { exact: true })).toBeVisible();
  const urls = await page.evaluate(() => (window as unknown as Harness).scopedUrls);
  expect(new URL(urls.at(-1)!).searchParams.has("lastEventId")).toBe(false);
  expect(latestRequests()).toBe(1);
  await deliver(page, rows(2000, 2002));
  await expect(page.getByText("tool_result: Tool 2002", { exact: true })).toBeVisible();
  await expect(page.locator('[data-message-key="2000"]')).toHaveCount(1);
});

for (const size of [{ width: 360, height: 780 }, { width: 1280, height: 900 }]) {
  test(`early loading keeps continuous scrolling away from the unloaded edge at ${size.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(size);
    let requested = 0;
    await page.route("**/history?before=1801*", async (route) => {
      requested++;
      await new Promise((resolve) => setTimeout(resolve, 900));
      await route.fulfill({ json: { events: rows(1601, 1800), before: 1601, cursor: 2000 } });
    });
    await recent(page);
    const metrics = await viewport(page).evaluate(async (el) => {
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })); el.scrollTop = el.clientHeight * 2.5;
      // Settle the test's initial jump before simulating a continuous drag.
      for (let frame = 0; frame < 4; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      }
      const longTasks: number[] = [];
      const observer = new PerformanceObserver((list) => {
        longTasks.push(...list.getEntries().map((entry) => entry.duration));
      });
      observer.observe({ type: "longtask" });
      const started = performance.now();
      let previous = started;
      let edgeFrames = 0;
      let maxFrameGap = 0;
      while (performance.now() - started < 3000) {
        // Let this frame's resize measurements and layout corrections finish.
        await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
        const now = performance.now();
        const elapsed = now - previous;
        maxFrameGap = Math.max(maxFrameGap, elapsed);
        previous = now;
        // One viewport per second: a continuous upward drag through the page boundary.
        el.scrollTop -= el.clientHeight * elapsed / 1000;
        if (el.scrollTop <= 1) edgeFrames++;
      }
      longTasks.push(...observer.takeRecords().map((entry) => entry.duration));
      observer.disconnect();
      return { edgeFrames, maxFrameGap, longTasks };
    });
    await testInfo.attach("scroll-metrics", { body: JSON.stringify(metrics), contentType: "application/json" });
    expect(requested).toBe(1);
    expect(metrics.edgeFrames).toBe(0);
    // The drag crossed into the older page without waiting at its boundary.
    await expect.poll(() => viewport(page).evaluate((el) => {
      const pane = el.getBoundingClientRect();
      return Array.from(el.querySelectorAll<HTMLElement>("[data-message-key]"))
        .some((row) => Number(row.dataset.messageKey) < 1801 && row.getBoundingClientRect().bottom > pane.top && row.getBoundingClientRect().top < pane.bottom);
    })).toBe(true);
    await expect(page.getByText("Loading earlier messages…", { exact: true })).toHaveCount(0);
  });
}

test("early loading adapts to a resized viewport without another scroll gesture", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 520 });
  let requested = 0;
  await page.route("**/history?before=1801*", async (route) => {
    requested++;
    await route.fulfill({ json: { events: rows(1601, 1800), before: 1601, cursor: 2000 } });
  });
  await recent(page);
  await viewport(page).evaluate((el) => { el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })); el.scrollTop = 1700; });
  await page.waitForTimeout(150);
  expect(requested).toBe(0);
  await page.setViewportSize({ width: 360, height: 1000 });
  await expect.poll(() => requested).toBe(1);
  await expect.poll(() => viewport(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(2000);
});
