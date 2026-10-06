import { test, expect } from "@playwright/test";
import { tasks } from "../fixtures.mjs";
import { assertViewportLocked, captureForReview } from "./_helpers";
import { installScopedStream } from "./_session-stream";

test.use({ serviceWorkers: "block" });

function gate() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

for (const theme of ["dark", "light"] as const) test(`initial history uses one skeleton state for a running task in ${theme} mode`, async ({ page, context }) => {
  await installScopedStream(page);
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme });
  const pending = gate();
  const task = tasks.find(task => task.taskId === "t-run")!;
  let reads = 0;
  await page.route(/\/api\/tasks\/t-run\/history(?:\?.*)?$/, async route => {
    reads++;
    await pending.wait;
    await route.fulfill({ json: { task, events: [{ seq: 1, event: {
      taskId: task.taskId, agent: task.agent, ts: 1, kind: "assistant_text", payload: { text: "Loaded conversation" },
    } }], cursor: 1, before: null } });
  });
  await page.goto(`/?__theme=${theme}#/task/t-run`);
  const loading = page.getByRole("status", { name: "Loading conversation", exact: true });
  await expect(loading).toBeVisible();
  await expect(page.getByText("Loading conversation…", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Loading history…", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Working…", { exact: true })).toHaveCount(0);
  const placeholders = loading.locator('[data-slot="skeleton"]');
  await expect(placeholders.first()).toBeVisible();
  for (const placeholder of await placeholders.all()) await expect(placeholder).toHaveCSS("animation-name", "none");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(composer).toBeInViewport({ ratio: 1 });
  const node = await composer.elementHandle();
  await assertViewportLocked(page);
  await captureForReview(page, `conversation-loading-${theme}.png`);

  pending.release();
  await expect(page.getByText("Loaded conversation", { exact: true })).toBeVisible();
  await expect(loading).toHaveCount(0);
  expect(await node!.evaluate(el => el.isConnected)).toBe(true);
  await context.setOffline(true);
  await page.evaluate(() => { location.hash = "/spaces"; });
  await expect(composer).toHaveCount(0);
  await page.evaluate(() => { location.hash = "/task/t-run"; });
  await expect(page.getByText("Loaded conversation", { exact: true })).toBeVisible();
  await expect(loading).toHaveCount(0);
  await expect(page.getByText("Waiting for connection…", { exact: true })).toHaveCount(0);
  expect(reads).toBe(1);
});

test("an uncached conversation waits offline and starts history once on reconnect", async ({ page, context }) => {
  await installScopedStream(page);
  const pending = gate();
  let reads = 0;
  await page.route(/\/api\/tasks\/t-run\/history(?:\?.*)?$/, async route => {
    reads++;
    await pending.wait;
    await route.fulfill({ json: { events: [{ seq: 1, event: {
      taskId: "t-run", agent: "claude", ts: 1, kind: "assistant_text", payload: { text: "Connected conversation" },
    } }], cursor: 1, before: null } });
  });
  await page.goto("/#/spaces");
  await expect(page.getByRole("region", { name: "Spaces list" })).toBeVisible();
  await context.setOffline(true);
  await page.evaluate(() => { location.hash = "/task/t-run"; });
  const waiting = page.getByRole("status").filter({ hasText: "Waiting for connection…" });
  const loading = page.getByRole("status", { name: "Loading conversation", exact: true });
  await expect(waiting).toBeVisible();
  await expect(loading).toHaveCount(0);
  await expect(page.getByText("Working…", { exact: true })).toHaveCount(0);
  await expect(page.getByText("waiting for events…", { exact: true })).toHaveCount(0);
  expect(reads).toBe(0);
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  const node = await composer.elementHandle();
  await expect(composer).toBeInViewport({ ratio: 1 });
  await assertViewportLocked(page);
  await captureForReview(page, "conversation-offline.png");

  await context.setOffline(false);
  await expect(loading).toBeVisible();
  await expect(waiting).toHaveCount(0);
  pending.release();
  await expect(page.getByText("Connected conversation", { exact: true })).toBeVisible();
  await expect(loading).toHaveCount(0);
  expect(await node!.evaluate(el => el.isConnected)).toBe(true);
  expect(reads).toBe(1);
});

test("retrying initial history offline waits for reconnection without another request", async ({ page, context }) => {
  await installScopedStream(page);
  let reads = 0;
  await page.route(/\/api\/tasks\/t-idle-rich\/history(?:\?.*)?$/, route => {
    if (++reads === 1) return route.fulfill({ status: 503, json: { error: "History temporarily unavailable" } });
    return route.fulfill({ json: { events: [], cursor: 0, before: null } });
  });
  await page.goto("/#/task/t-idle-rich");
  const retry = page.getByRole("button", { name: "Retry loading conversation", exact: true });
  await expect(retry).toBeVisible();
  await context.setOffline(true);
  await retry.click();
  await expect(page.getByRole("status").filter({ hasText: "Waiting for connection…" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(retry).toHaveCount(0);
  expect(reads).toBe(1);
  await context.setOffline(false);
  await expect.poll(() => reads).toBe(2);
  await expect(page.getByText("Waiting for connection…", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("status", { name: "Loading conversation", exact: true })).toHaveCount(0);
});

test("a new conversation stays ready to compose while offline without starting history", async ({ page, context }) => {
  await page.goto("/#/spaces");
  await expect(page.getByRole("region", { name: "Spaces list" })).toBeVisible();
  await context.setOffline(true);
  await page.evaluate(() => { location.hash = "/new/space/repo-app"; });
  await expect(page.getByText("What should we work on?", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toBeEnabled();
  await expect(page.getByText("Waiting for connection…", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("status", { name: "Loading conversation", exact: true })).toHaveCount(0);
});

test("initial history failure exposes retry and returns to the skeleton while retrying", async ({ page }) => {
  await installScopedStream(page);
  const retry = gate();
  let reads = 0;
  await page.route(/\/api\/tasks\/t-idle-rich\/history(?:\?.*)?$/, async route => {
    if (++reads === 1) return route.fulfill({ status: 503, json: { error: "History temporarily unavailable" } });
    await retry.wait;
    await route.fulfill({ json: { events: [{ seq: 1, event: {
      taskId: "t-idle-rich", agent: "codex", ts: 1, kind: "assistant_text", payload: { text: "Recovered conversation" },
    } }], cursor: 1, before: null } });
  });
  await page.goto("/#/task/t-idle-rich");
  const loading = page.getByRole("status", { name: "Loading conversation", exact: true });
  await expect(page.getByRole("alert")).toContainText("History temporarily unavailable");
  await expect(loading).toHaveCount(0);
  await expect(page.getByText("waiting for events…", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry loading conversation", exact: true }).click();
  await expect(loading).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  retry.release();
  await expect(loading).toHaveCount(0);
  await expect(page.getByText("Recovered conversation", { exact: true })).toBeVisible();
});
