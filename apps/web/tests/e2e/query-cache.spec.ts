import { test, expect } from "@playwright/test";
import { queryOptions } from "@tanstack/react-query";
import { routines, routineRuns } from "../fixtures.mjs";
import { clientReadKeys } from "../../src/client-query-keys";
import { invalidateClientReads } from "../../src/query-lifecycle";
import { queryClient, taskHistoryKey } from "../../src/task-history-query";

test("TanStack Query shares reads, scopes invalidation and clears cache on session changes", async () => {
  let reads = 0;
  const reposQueryOptions = () => queryOptions({
    queryKey: clientReadKeys.repos(),
    queryFn: async () => [{ id: `repo-${++reads}` }],
    staleTime: 30_000,
  });
  queryClient.clear();
  try {
    const initial = await Promise.all([
      queryClient.fetchQuery(reposQueryOptions()),
      queryClient.fetchQuery(reposQueryOptions()),
    ]);
    expect(initial.map((repos) => repos[0]?.id)).toEqual(["repo-1", "repo-1"]);
    expect(reads).toBe(1);
    expect((await queryClient.fetchQuery(reposQueryOptions()))[0]?.id).toBe("repo-1");

    queryClient.setQueryData(clientReadKeys.modelCatalog(), { cached: true });
    await invalidateClientReads(false, ["repos"]);
    expect((await queryClient.fetchQuery(reposQueryOptions()))[0]?.id).toBe("repo-2");
    expect(queryClient.getQueryData(clientReadKeys.modelCatalog())).toEqual({ cached: true });
    expect(reads).toBe(2);

    queryClient.setQueryData(taskHistoryKey("private-session"), { pages: [], pageParams: [] });
    await invalidateClientReads(true);
    expect(queryClient.getQueryData(clientReadKeys.repos())).toBeUndefined();
    expect(queryClient.getQueryData(clientReadKeys.modelCatalog())).toBeUndefined();
    expect(queryClient.getQueryData(taskHistoryKey("private-session"))).toBeUndefined();
  } finally {
    queryClient.clear();
  }
});

test("inactive TanStack history stays within the transcript count and size budgets", async () => {
  queryClient.clear();
  const page = { items: [], before: null, cursor: 12 };
  for (const id of ["a", "b", "c", "d", "e", "f"]) {
    queryClient.setQueryData(taskHistoryKey(id), { pages: [page], pageParams: [null] });
  }
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(["a", "b", "c", "d", "e", "f"].filter(id => queryClient.getQueryData(taskHistoryKey(id)))).toHaveLength(5);
  queryClient.setQueryData(taskHistoryKey("large"), { pages: [{ ...page, items: [{ key: 1, text: "x".repeat(2_100_000) }] }], pageParams: [null] });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(queryClient.getQueryData(taskHistoryKey("large"))).toBeUndefined();
  queryClient.clear();
});

test.describe("REST navigation reuse", () => {
  test.use({ serviceWorkers: "block" });
  test("repositories are reused across screens and revalidated after foregrounding", async ({ page }) => {
    let reads = 0;
    await page.route("**/api/repos", async route => { reads++; await route.continue(); });
    const visit = page.waitForResponse(response => new URL(response.url()).pathname === "/api/settings/updates"
      && response.request().method() === "POST");
    await page.goto("/");
    await expect.poll(() => reads).toBe(1);
    // Navigation can render before the startup mutation finishes invalidating reads.
    await (await visit).finished();
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
    await page.evaluate(() => { location.hash = "/new"; });
    // The prompt renders before the repository request completes.
    await expect(page.getByRole("combobox", { name: "Working directory" })).toBeEnabled();
    const warm = reads;
    await page.evaluate(() => { location.hash = "/"; });
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
    await page.evaluate(() => { location.hash = "/new"; });
    await expect(page.getByRole("combobox", { name: "Working directory" })).toBeEnabled();
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
  test("routine settings keep open history cached; reconnect refreshes active reads", async ({ page }) => {
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
    await expect(page.getByRole("switch", { name: "Enabled" }).first()).not.toBeChecked();
    expect(historyReads).toBe(1);
    expect(listReads).toBe(previous);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => historyReads).toBe(2);
    await expect.poll(() => listReads).toBe(previous + 1);
  });
});
