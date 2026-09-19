import { test, expect } from "@playwright/test";
import { routines, routineRuns } from "../fixtures.mjs";
import { ReadCache, readCache, invalidateClientReads } from "../../src/read-cache";
import { HistoryCache, historyCache, type HistorySnapshot } from "../../src/history-cache";

test("reads deduplicate, expire, retry failures and cannot refill after invalidation", async () => {
  let now = 0, calls = 0;
  const cache = new ReadCache(2, () => now);
  const load = async () => ++calls;
  expect(await Promise.all([cache.read("a", 10, load), cache.read("a", 10, load)])).toEqual([1, 1]);
  now = 9; expect(await cache.read("a", 10, load)).toBe(1);
  now = 10; expect(await cache.read("a", 10, load)).toBe(2);
  let resolve!: (value: number) => void;
  const pending = cache.read("race", 10, () => new Promise<number>(done => { resolve = done; }));
  await Promise.resolve();
  cache.invalidate();
  expect(await cache.read("race", 10, load)).toBe(3);
  resolve(99); await pending;
  expect(await cache.read("race", 10, load)).toBe(3);
  await expect(cache.read("error", 10, async () => { throw new Error("offline"); })).rejects.toThrow("offline");
  expect(await cache.read("error", 10, load)).toBe(4);
  await cache.read("third", 10, load);
  expect(await cache.read("race", 10, load)).toBe(6);
});

test("history retains whole snapshots within time, count and size bounds", () => {
  let now = 0;
  const cache = new HistoryCache(1000, 2, () => now);
  const snapshot: HistorySnapshot = { items: [], lastSeq: 12, before: 4 };
  cache.set("a", snapshot); cache.set("b", snapshot);
  expect(cache.get("a")).toBe(snapshot);
  cache.set("c", snapshot); expect(cache.get("b")).toBeUndefined();
  cache.set("a", { ...snapshot, items: [{ key: 1, kind: "assistant_text", agent: "codex", text: "x".repeat(1000) }] });
  expect(cache.get("a")).toBeUndefined();
  now = 300_001; expect(cache.get("c")).toBeUndefined();
  cache.set("d", snapshot); cache.clear(); expect(cache.get("d")).toBeUndefined();
});

test.describe("REST navigation reuse", () => {
  test.use({ serviceWorkers: "block" });
  test("repositories are reused across screens and revalidated after foregrounding", async ({ page }) => {
    let reads = 0;
    await page.route("**/api/repos", async route => { reads++; await route.continue(); });
    await page.goto("/");
    await expect.poll(() => reads).toBe(1);
    // Let the app-access mutation finish before warming the cache.
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
    await page.evaluate(() => { location.hash = "/new"; });
    await expect(page.getByLabel("Prompt")).toBeVisible();
    const warm = reads;
    await page.evaluate(() => { location.hash = "/"; });
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
    await page.evaluate(() => { location.hash = "/new"; });
    await expect(page.getByLabel("Prompt")).toBeVisible();
    expect(reads).toBe(warm);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.evaluate(() => { location.hash = "/"; });
    await expect.poll(() => reads).toBeGreaterThan(warm);
  });
});

test("real service worker removes legacy API data and only serves the shell offline", async ({ page, context }) => {
  await page.goto("/manifest.webmanifest");
  const paths = ["/api/auth/me", "/api/repos", "/api/tasks", "/api/routines", "/api/usage"];
  await page.evaluate(async paths => {
    const cache = await caches.open("api");
    for (const path of paths) await cache.put(path, new Response(JSON.stringify({ stale: true })));
  }, paths);
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  expect(await page.evaluate(() => caches.keys())).not.toContain("api");
  await page.evaluate(async paths => { for (const path of paths) await fetch(path); }, paths);
  expect(await page.evaluate(() => caches.keys())).not.toContain("api");
  await context.setOffline(true);
  const results = await page.evaluate(async paths => Promise.all(paths.map(async path => {
    try { await fetch(path); return "unexpected response"; } catch { return "network failure"; }
  })), paths);
  expect(results).toEqual(paths.map(() => "network failure"));
  await page.reload();
  await expect(page.getByRole("button", { name: "Sign in with passkey" })).toBeVisible();
});


test.describe("routine cache invalidation", () => {
  test.use({ serviceWorkers: "block" });
  test("mutation responses update the list and refresh open history; foreground reads are fresh", async ({ page }) => {
    await page.clock.setFixedTime(new Date());
    const list = structuredClone(routines);
    let listReads = 0, historyReads = 0;
    await page.route("**/api/routines", async route => {
      listReads++;
      await route.fulfill({ json: { routines: list } });
    });
    await page.route("**/api/routines/r-standup/runs", async route => {
      historyReads++;
      await route.fulfill({ json: { runs: routineRuns["r-standup"] } });
    });
    await page.route("**/api/routines/r-standup", async route => {
      list[0].enabled = !list[0].enabled;
      list[0].updatedAt++;
      await route.fulfill({ json: { routine: list[0] } });
    });
    await page.goto("/#/routines");
    const history = page.getByRole("button", { name: /^(History|Hide history)$/ }).first();
    await history.click();
    await expect(page.getByText("Skipped (server was down)")).toBeVisible();
    expect(historyReads).toBe(1);
    await history.click(); await history.click();
    await expect(page.getByText("Skipped (server was down)")).toBeVisible();
    expect(historyReads).toBe(1);
    const previous = listReads;
    await page.getByRole("switch", { name: "Enabled" }).first().click();
    await expect.poll(() => historyReads).toBe(2);
    await expect(page.getByRole("switch", { name: "Enabled" }).first()).not.toBeChecked();
    expect(listReads).toBe(previous);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => historyReads).toBe(3);
    await expect.poll(() => listReads).toBe(previous + 1);
  });
});


test("authentication changes clear both response and transcript caches", async () => {
  historyCache.set("private-session", { items: [], lastSeq: 2, before: null });
  await readCache.read("/api/repos", 30_000, async () => "previous session");
  invalidateClientReads(true);
  expect(historyCache.get("private-session")).toBeUndefined();
  expect(await readCache.read("/api/repos", 30_000, async () => "current session")).toBe("current session");
  invalidateClientReads(true);
});
