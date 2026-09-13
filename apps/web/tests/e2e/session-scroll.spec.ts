import { test, expect, type Page } from "@playwright/test";

// Deliver scoped SSE frames across separate browser turns, including pauses and
// reconnects. The inbox and the rest of the app still use the mock HTTP server.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    const streams = new Map<string, EventSource>();
    class ScopedStream extends EventTarget {
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor(url: string | URL) {
        super();
        const parsed = new URL(url, location.href);
        const taskId = parsed.searchParams.get("task");
        if (!taskId) return new NativeEventSource(url) as unknown as ScopedStream;
        streams.set(taskId, this as unknown as EventSource);
        queueMicrotask(() => this.onopen?.(new Event("open")));
      }
      close() {}
    }
    window.EventSource = ScopedStream as unknown as typeof EventSource;
    Object.assign(window, {
      sendScopedFrame(taskId: string, frame: unknown, seq = 0) {
        streams.get(taskId)?.onmessage?.(new MessageEvent("message", {
          data: JSON.stringify(frame), lastEventId: String(seq),
        }));
      },
      hasScopedStream(taskId: string) { return streams.has(taskId); },
    });
  });
});

type Harness = Window & {
  sendScopedFrame(taskId: string, frame: unknown, seq?: number): void;
  hasScopedStream(taskId: string): boolean;
};
async function send(page: Page, taskId: string, frame: unknown, seq = 0) {
  await page.evaluate(({ taskId, frame, seq }) => {
    (window as unknown as Harness).sendScopedFrame(taskId, frame, seq);
  }, { taskId, frame, seq });
}
async function event(page: Page, taskId: string, seq: number, text: string) {
  await send(page, taskId, { type: "event", event: {
    taskId, agent: "codex", ts: seq, kind: "assistant_text", payload: { text },
  } }, seq);
}
async function open(page: Page, taskId: string) {
  await page.goto(`/#/task/${taskId}`);
  await expect.poll(() => page.evaluate((id) =>
    (window as unknown as Harness).hasScopedStream(id), taskId)).toBe(true);
}
const viewport = (page: Page) => page.locator("[data-radix-scroll-area-viewport]").first();
async function expectBottom(page: Page) {
  await expect.poll(() => viewport(page).evaluate((el) =>
    el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(1);
}

test("opens delayed history at the bottom and preserves live follow and reading position", async ({ page }) => {
  await open(page, "t-idle-rich");
  await send(page, "t-idle-rich", { type: "tasks", tasks: [], replayThrough: 3 });
  await event(page, "t-idle-rich", 1, "Earlier history\n\n".repeat(100));
  await expect(page.getByText("Loading history…")).toBeVisible();
  await expect(page.getByText(/Earlier history/)).toHaveCount(0);
  await event(page, "t-idle-rich", 2, "Middle history\n\n".repeat(100));
  await expect(page.getByText(/Middle history/)).toHaveCount(0);

  // Inspect every painted frame once history becomes visible, rather than
  // accepting a view which eventually reaches the bottom after scrolling.
  await page.evaluate(() => {
    const samples: number[] = [];
    Object.assign(window, { initialScrollSamples: samples });
    const sample = () => {
      const el = document.querySelector("[data-radix-scroll-area-viewport]");
      if (el?.textContent?.includes("Latest history")) {
        samples.push(el.scrollHeight - el.clientHeight - el.scrollTop);
      }
      if (samples.length < 5) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await event(page, "t-idle-rich", 3, "Latest history");
  await expect(page.getByText("Loading history…")).toHaveCount(0);
  await expectBottom(page);
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { initialScrollSamples: number[] }).initialScrollSamples.length)).toBe(5);
  const samples = await page.evaluate(() =>
    (window as unknown as { initialScrollSamples: number[] }).initialScrollSamples);
  expect(samples.every((gap) => gap <= 1), `first visible frames: ${samples}`).toBe(true);

  await event(page, "t-idle-rich", 4, "\n\nLive update\n\n".repeat(20));
  await expect(page.getByText(/Live update/)).toHaveCount(20);
  await expectBottom(page);
  await viewport(page).evaluate((el) => {
    el.scrollTop = 100;
    el.dispatchEvent(new Event("scroll"));
  });
  await event(page, "t-idle-rich", 5, "\n\nWhile reading");
  await expect(page.getByText(/While reading/)).toHaveCount(1);
  expect(await viewport(page).evaluate((el) => el.scrollTop)).toBe(100);

  // Foreground reconnects keep the visible transcript and the reader's place.
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await send(page, "t-idle-rich", { type: "tasks", tasks: [], replayThrough: 6 });
  await event(page, "t-idle-rich", 5, "DUPLICATE");
  await event(page, "t-idle-rich", 6, "\n\nReconnected update");
  await expect(page.getByText(/Reconnected update/)).toHaveCount(1);
  await expect(page.getByText(/DUPLICATE/)).toHaveCount(0);
  expect(await viewport(page).evaluate((el) => el.scrollTop)).toBe(100);

  // A direct session switch must not inherit the previous session's scroll lock.
  await page.evaluate(() => { location.hash = "/task/t-run"; });
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as Harness).hasScopedStream("t-run"))).toBe(true);
  await send(page, "t-run", { type: "tasks", tasks: [], replayThrough: 1 });
  await expect(page.getByText(/Earlier history/)).toHaveCount(0);
  await event(page, "t-run", 1, "Other session\n\n".repeat(100));
  await expectBottom(page);
});

test("a reconnect during initial replay retains buffered history without duplicates", async ({ page }) => {
  await open(page, "t-idle-rich");
  await send(page, "t-idle-rich", { type: "tasks", tasks: [], replayThrough: 3 });
  await event(page, "t-idle-rich", 1, "Start\n\n");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await send(page, "t-idle-rich", { type: "tasks", tasks: [], replayThrough: 4 });
  await event(page, "t-idle-rich", 1, "DUPLICATE");
  await event(page, "t-idle-rich", 2, "Middle\n\n");
  await event(page, "t-idle-rich", 3, "End\n\n");
  await expect(page.getByText("Loading history…")).toBeVisible();
  await event(page, "t-idle-rich", 4, "Caught up");
  await expect(page.getByText("Start", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Caught up", { exact: true })).toHaveCount(1);
  await expect(page.getByText(/DUPLICATE/)).toHaveCount(0);
});

test("empty history and older servers do not leave a loading state", async ({ page }) => {
  await open(page, "t-run");
  await send(page, "t-run", { type: "tasks", tasks: [], replayThrough: 0 });
  await expect(page.getByText("Loading history…")).toHaveCount(0);
  await event(page, "t-run", 1, "First live message");
  await expect(page.getByText("First live message")).toBeVisible();
  await page.reload();
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as Harness).hasScopedStream("t-run"))).toBe(true);
  await send(page, "t-run", { type: "tasks", tasks: [] });
  await event(page, "t-run", 1, "Legacy history");
  await expect(page.getByText("Legacy history")).toBeVisible();
});
