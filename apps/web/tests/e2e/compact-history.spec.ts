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

test("legacy summaries load only the selected operation and retain its cached details", async ({ page }) => {
  const rows = conversation(), pending = gate();
  const reads: number[] = [];
  await page.route(historyPath, route => route.fulfill({ json: { events: rows.map(({ seq, event }) => ({ seq, ...deferActivityEventDetails(event) })), before: null, cursor: rows.length } }));
  await page.route(detailsPath, async route => {
    const q = new URL(route.request().url()).searchParams, from = Number(q.get("from")), through = Number(q.get("through"));
    reads.push(from); expect(through).toBe(from);
    await pending.wait;
    await route.fulfill({ json: { events: rows.filter(row => row.seq === from), from, through, cursor: rows.length } });
  });
  await page.goto(`/#/task/${taskId}`);
  const activity = page.getByRole("button", { name: "Activity · 250 tools", exact: true });
  await expect(page.getByText("Complete answer", { exact: true })).toBeVisible();
  await activity.click();
  await expect(page.locator("[data-trace-step]")).toHaveCount(50);
  expect(reads).toEqual([]);
  await page.locator('[data-trace-step="2"]').click();
  await expect.poll(() => reads.length).toBe(2);
  expect(reads.sort()).toEqual([2, 3]);
  await expect(page.getByText("Loading step details…", { exact: true })).toBeVisible();
  pending.release();
  await expect(page.getByText("Expanded output 0", { exact: false })).toBeVisible();
  await expect(page.getByText("Expanded output 1", { exact: false })).toHaveCount(0);
  await activity.click(); await activity.click();
  await expect(page.getByText("Expanded output 0", { exact: false })).toBeVisible();
  expect(reads).toHaveLength(2);
});

for (const fail of [false, true]) test(`an opened legacy step fetches only its late result${fail ? " and retries a failed detail" : ""}`, async ({ page }) => {
  const rows = conversation().slice(0, 3), reads: number[] = [];
  let failed = false;
  await page.route(historyPath, route => route.fulfill({ json: { events: rows.slice(0, 2).map(({ seq, event }) => ({ seq, ...deferActivityEventDetails(event) })), before: null, cursor: 2 } }));
  await page.route(detailsPath, route => {
    const from = Number(new URL(route.request().url()).searchParams.get("from")); reads.push(from);
    if (from === 3 && fail && !failed) { failed = true; return route.fulfill({ status: 503, json: { error: "Unavailable" } }); }
    return route.fulfill({ json: { events: rows.filter(row => row.seq === from), from, through: from, cursor: 3 } });
  });
  await page.goto(`/#/task/${taskId}`);
  const activity = page.getByRole("button", { name: "Activity · 1 tool", exact: true });
  await activity.click(); await page.locator('[data-trace-step="2"]').click();
  await expect.poll(() => reads).toEqual([2]);
  await expect(page.getByText("Loading step details…", { exact: true })).toHaveCount(0);
  await send(page, taskId, { type: "event", ...deferActivityEventDetails(rows[2].event) }, 3);
  if (fail) {
    await expect(page.getByRole("alert")).toContainText("Couldn’t load details.");
    await page.getByRole("button", { name: "Retry", exact: true }).click();
  }
  await expect(page.getByText("Expanded output 0", { exact: false })).toBeVisible();
  expect(reads).toEqual(fail ? [2, 3, 3] : [2, 3]);
});

test("closing legacy details cancels only pending members and keeps completed member caches", async ({ page }) => {
  const rows = conversation().slice(0, 3), pending = gate(), reads: number[] = [];
  let cancelled = 0;
  page.on("requestfailed", request => { if (detailsPath.test(request.url())) cancelled++; });
  await page.route(historyPath, route => route.fulfill({ json: { events: rows.map(({ seq, event }) => ({ seq, ...deferActivityEventDetails(event) })), before: null, cursor: 3 } }));
  await page.route(detailsPath, async route => {
    const from = Number(new URL(route.request().url()).searchParams.get("from")); reads.push(from);
    if (from === 3) await pending.wait;
    await route.fulfill({ json: { events: rows.filter(row => row.seq === from), from, through: from, cursor: 3 } });
  });
  await page.goto(`/#/task/${taskId}`);
  const activity = page.getByRole("button", { name: "Activity · 1 tool", exact: true });
  await activity.click(); await page.locator('[data-trace-step="2"]').click();
  await expect.poll(() => reads.length).toBe(2);
  await expect(page.getByText('Read {"path":"file-0.txt"}', { exact: false })).toBeVisible();
  await activity.click(); await expect.poll(() => cancelled).toBe(1);
  pending.release(); await activity.click();
  await expect(page.getByText("Expanded output 0", { exact: false })).toBeVisible();
  expect(reads).toEqual([2, 3, 3]);
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
