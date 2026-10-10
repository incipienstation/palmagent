import { test, expect } from "@playwright/test";
import { deferActivityEventDetails, type TaskHistoryEvent } from "@palmagent/shared";
import { installScopedStream, send, event, type Harness } from "./_scoped-stream";

test.use({ serviceWorkers: "block" });
const taskId = "t-idle-rich";
const historyPath = new RegExp(`/api/tasks/${taskId}/history(?:\\?.*)?$`);
const detailsPath = new RegExp(`/api/tasks/${taskId}/history/details(?:\\?.*)?$`);

function gate() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

function conversation(): TaskHistoryEvent[] {
  const rows: TaskHistoryEvent[] = [];
  const add = (kind: TaskHistoryEvent["event"]["kind"], payload: Record<string, unknown>) => {
    const seq = rows.length + 1;
    rows.push({ seq, event: { taskId, agent: "codex", kind, payload, ts: seq } });
  };
  add("status", { subtype: "dispatch", text: "Original request" });
  for (let i = 0; i < 250; i++) {
    add("tool_call", { id: `tool-${i}`, name: "Read", input: { path: `file-${i}.txt` } });
    add("tool_result", { tool_use_id: `tool-${i}`, output: `Expanded output ${i}` });
  }
  add("assistant_text", { text: "Complete answer", phase: "final" });
  return rows;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pref:output-mode", "compact"));
  await installScopedStream(page);
});

test("compact history renders before SSE and fetches a whole Activity only when opened", async ({ page }) => {
  const rows = conversation();
  const pending = gate();
  const historyReads: string[] = [];
  const detailReads: string[] = [];
  await page.route(historyPath, route => {
    historyReads.push(route.request().url());
    return route.fulfill({ json: { events: rows.map(({ seq, event }) => ({ seq, ...deferActivityEventDetails(event) })), before: null, cursor: rows.length } });
  });
  await page.route(detailsPath, async route => {
    detailReads.push(route.request().url());
    await pending.wait;
    await route.fulfill({ json: { events: rows.slice(1, -1), from: 2, through: 501, cursor: rows.length } });
  });
  await page.goto(`/#/task/${taskId}`);
  // No first SSE snapshot has been delivered. REST alone makes the entire
  // compact conversation readable, including a work group over 200 events.
  await expect(page.getByText("Original request", { exact: true })).toBeVisible();
  await expect(page.getByText("Complete answer", { exact: true })).toBeVisible();
  const activity = page.getByRole("button", { name: "Activity · 250 tools", exact: true });
  await expect(activity).toBeVisible();
  await expect(activity).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("status", { name: "Loading conversation", exact: true })).toHaveCount(0);
  expect(detailReads).toEqual([]);
  expect(historyReads).toHaveLength(1);
  expect(new URL(historyReads[0]).searchParams.get("details")).toBe("summary");
  await expect(page.getByText("Loading earlier messages…", { exact: true })).toHaveCount(0);

  await expect.poll(() => page.evaluate(id => (window as unknown as Harness).hasScopedStream(id), taskId)).toBe(true);
  await send(page, taskId, { type: "tasks", tasks: [], historyThrough: rows.length });
  await event(page, taskId, rows.length + 1, "\n\nNew streamed answer");
  await expect(page.getByText("New streamed answer", { exact: true })).toBeVisible();
  expect(detailReads).toEqual([]);

  await activity.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => detailReads.length).toBe(1);
  expect(new URL(detailReads[0]).searchParams.get("from")).toBe("2");
  expect(new URL(detailReads[0]).searchParams.get("through")).toBe("501");
  await expect(page.getByText("Loading activity details…", { exact: true })).toBeVisible();
  await expect(page.getByText("Loading earlier messages…", { exact: true })).toHaveCount(0);
  pending.release();
  await expect(page.getByText("Expanded output 0", { exact: false })).toBeVisible();
  await expect(page.getByText("Loading activity details…", { exact: true })).toHaveCount(0);
  expect(await page.locator("[data-message-key]").count()).toBeLessThan(50);
  await activity.click();
  await expect(page.getByText("Complete answer", { exact: true })).toBeVisible();
  await activity.click();
  await expect(page.getByText("Expanded output 0", { exact: false })).toBeVisible();
  expect(detailReads).toHaveLength(1);
  expect(historyReads).toHaveLength(1);
});

test("an Activity detail failure stays within its disclosure and retries without reloading history", async ({ page }) => {
  const rows = conversation();
  let historyReads = 0, detailReads = 0;
  await page.route(historyPath, route => {
    historyReads++;
    return route.fulfill({ json: { events: rows.map(({ seq, event }) => ({ seq, ...deferActivityEventDetails(event) })), before: null, cursor: rows.length } });
  });
  await page.route(detailsPath, route => ++detailReads === 1
    ? route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } })
    : route.fulfill({ json: { events: rows.slice(1, -1), from: 2, through: 501, cursor: rows.length } }));
  await page.goto(`/#/task/${taskId}`);
  const activity = page.getByRole("button", { name: "Activity · 250 tools", exact: true });
  await activity.click();
  await expect(page.getByRole("alert")).toContainText("Couldn’t load activity details.");
  await expect(page.getByText("Complete answer", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("Expanded output 0", { exact: false })).toBeVisible();
  expect(detailReads).toBe(2);
  expect(historyReads).toBe(1);
});

for (const failure of [false, true]) test(`an old paged checkpoint stays visible during compact upgrade${failure ? " and retry" : ""} before SSE attaches`, async ({ page }) => {
  const rows = conversation();
  const pending = gate();
  let historyReads = 0;
  await page.route(historyPath, async route => {
    historyReads++;
    if (failure && historyReads === 1) return route.fulfill({ status: 503, json: { error: "History temporarily unavailable" } });
    await pending.wait;
    await route.fulfill({ json: { events: rows.map(({ seq, event }) => ({ seq, ...deferActivityEventDetails(event) })), before: null, cursor: rows.length } });
  });
  await page.goto("/#/spaces");
  await page.evaluate(async taskId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("palmagent-screen-state", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("checkpoints");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("checkpoints", "readwrite");
        tx.objectStore("checkpoints").put({ route: `#/task/${taskId}`, created: Date.now(), screen: { scroll: [] }, values: {
          [`history:${taskId}`]: { pages: [{ items: [{ key: 502, endSeq: 502, kind: "assistant_text", agent: "codex", text: "Cached answer", phase: "final" }], before: 303, cursor: 502 }], pageParams: [null] },
        } }, "paged-compact");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      sessionStorage.setItem("palmagent:screen-checkpoint", "paged-compact");
    } finally { db.close(); }
  }, taskId);
  await page.goto(`/?checkpoint=compact#/task/${taskId}`);
  await expect(page.getByText("Cached answer", { exact: true })).toBeVisible();
  await expect.poll(() => historyReads).toBe(1);
  if (failure) {
    await expect(page.getByRole("alert")).toContainText("History temporarily unavailable");
    await expect(page.getByText("Cached answer", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Retry loading conversation", exact: true }).click();
    await expect.poll(() => historyReads).toBe(2);
  }
  expect(await page.evaluate(id => (window as unknown as Harness).hasScopedStream(id), taskId)).toBe(false);
  await expect(page.getByRole("status", { name: "Loading conversation", exact: true })).toHaveCount(0);
  await expect(page.getByText("Loading earlier messages…", { exact: true })).toHaveCount(0);
  pending.release();
  await expect(page.getByText("Original request", { exact: true })).toBeVisible();
  await expect(page.getByText("Complete answer", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(id => (window as unknown as Harness).hasScopedStream(id), taskId)).toBe(true);
  expect(historyReads).toBe(failure ? 2 : 1);
});
