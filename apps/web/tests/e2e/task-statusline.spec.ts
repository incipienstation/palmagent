import { test, expect, type Page } from "@playwright/test";
import type { AccountLimits } from "@palmagent/shared";
import { assertViewportLocked } from "./_helpers";

// Route fixtures must also intercept polls after the first paint. The final test
// exercises network-only account reads through the real service worker.
test.use({ serviceWorkers: "block" });

const now = Date.UTC(2030, 0, 1, 12);
const reset = now + 100 * 60_000;
const claude: AccountLimits = {
  agent: "claude", state: "ready", checkedAt: now,
  fiveHour: { usedPercent: 28, resetsAt: reset }, sevenDay: { usedPercent: 62, resetsAt: now + 3 * 86400000 },
  modelLimits: [{ name: "Fable", window: { usedPercent: 95, resetsAt: now + 86400000 } }], extraUsage: { usedPercent: 12 },
};
const codex: AccountLimits = {
  agent: "codex", state: "ready", checkedAt: now, buckets: [
    { id: "codex", name: "Codex", primary: { usedPercent: 21, windowMinutes: 10080, resetsAt: reset } },
    { id: "spark", name: "Spark", primary: { usedPercent: 0, windowMinutes: 300, resetsAt: reset }, secondary: { usedPercent: 100, windowMinutes: 10080, resetsAt: now + 86400000 }, credits: { unlimited: false, balance: "12.5" } },
  ],
};
async function show(page: Page, report: AccountLimits, id = report.agent === "claude" ? "t-idle-rich" : "t-run-charts") {
  await page.clock.install({ time: now });
  await page.route(`**/api/tasks/${id}/account-limits`, route => route.fulfill({ json: report }));
  await page.goto(`/#/task/${id}`);
  return page.getByRole("region", { name: "Account limits" });
}

test("Claude's allowance and resets are visible above the idle composer, with model windows in Details", async ({ page }) => {
  const line = await show(page, claude);
  await expect(line.getByText("72% left", { exact: true })).toBeVisible();
  await expect(line.getByText("38% left", { exact: true })).toBeVisible();
  await expect(line.getByText("Resets in 1h 40m", { exact: true })).toBeVisible();
  await expect(line.getByText(/Input|Output|Cache|Reasoning/)).toHaveCount(0);
  await assertViewportLocked(page);
  await line.getByRole("button", { name: "Account limit details" }).click();
  const sheet = page.getByRole("dialog", { name: "Claude account limits" });
  await expect(sheet.getByText("Fable · Weekly")).toBeVisible();
  await expect(sheet.getByText("5% left", { exact: true })).toBeVisible();
  await expect(sheet.getByText("Extra usage enabled · 12% used")).toBeVisible();
  await expect(sheet.getByText(/Shared across sessions/)).toBeVisible();
  await assertViewportLocked(page);
});

test("Codex uses the reported weekly primary window and keeps model buckets distinct", async ({ page }) => {
  const line = await show(page, codex);
  await expect(line.getByText("Weekly", { exact: true })).toBeVisible();
  await expect(line.getByText("79% left", { exact: true })).toBeVisible();
  await expect(line.getByText("5h", { exact: true })).toHaveCount(0);
  await line.getByRole("button", { name: "Account limit details" }).click();
  const sheet = page.getByRole("dialog", { name: "Codex account limits" });
  await expect(sheet.getByRole("heading", { name: "Spark" })).toBeVisible();
  await expect(sheet.getByText("5h", { exact: true })).toBeVisible();
  await expect(sheet.getByText("100% left", { exact: true })).toBeVisible();
  await expect(sheet.getByText("0% left", { exact: true })).toBeVisible();
  await expect(sheet.getByText("Credits: 12.5")).toBeVisible();
  await assertViewportLocked(page);
});

test("missing percentages stay unknown and expired windows await a fresh report", async ({ page }) => {
  const line = await show(page, { ...claude, fiveHour: { usedPercent: null, resetsAt: reset }, sevenDay: { usedPercent: 90, resetsAt: now - 1000 } });
  await expect(line.getByText("Remaining unknown")).toBeVisible();
  await expect(line.getByText("Awaiting refresh")).toBeVisible();
  await expect(line.getByText("Reset time passed")).toBeVisible();
  await expect(line.getByText(/% left/)).toHaveCount(0);
});

test("the reset countdown advances and an idle refresh replaces old quota numbers", async ({ page }) => {
  const line = await show(page, claude);
  await expect(line.getByText("72% left")).toBeVisible();
  await page.route("**/api/tasks/t-idle-rich/account-limits", route => route.fulfill({ json: { ...claude, checkedAt: now + 60000, fiveHour: { usedPercent: 40, resetsAt: reset } } }));
  await page.clock.fastForward(60000);
  await expect(line.getByText("60% left")).toBeVisible();
  await expect(line.getByText("Resets in 1h 39m")).toBeVisible();
  await expect(line.getByText("72% left")).toHaveCount(0);
});

test("failed and unsupported reads show no fabricated allowance", async ({ page }) => {
  const line = await show(page, { agent: "claude", state: "unavailable", checkedAt: now, modelLimits: [] });
  await expect(line.getByText("This account does not report subscription limits")).toBeVisible();
  await page.route("**/api/tasks/t-idle-rich/account-limits", route => route.fulfill({ status: 503, json: { error: "offline" } }));
  await page.clock.fastForward(30000);
  await expect(line.getByText("Account limits temporarily unavailable")).toBeVisible();
  await expect(line.getByText(/% left/)).toHaveCount(0);
});

test("switching tasks clears the previous account report while the new read is pending", async ({ page }) => {
  const line = await show(page, claude);
  await expect(line.getByText("72% left")).toBeVisible();
  let complete!: () => void;
  const pending = new Promise<void>(resolve => { complete = resolve; });
  await page.route("**/api/tasks/t-run-charts/account-limits", async route => { await pending; await route.fulfill({ json: codex }); });
  await page.evaluate(() => { location.hash = "#/task/t-run-charts"; });
  await expect(line.getByText("Checking account limits…")).toBeVisible();
  await expect(line.getByText("72% left")).toHaveCount(0);
  complete();
  await expect(line.getByText("79% left")).toBeVisible();
});

test.describe("account limits with the real service worker", () => {
  test.use({ serviceWorkers: "allow" });
  test("offline reads never reuse a cached account allowance", async ({ page, context }) => {
    await page.goto("/");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await page.evaluate(async () => {
      const cache = await caches.open("api");
      await cache.put("/api/tasks/t-run/account-limits", new Response(JSON.stringify({ agent: "claude", state: "ready", checkedAt: Date.now(), fiveHour: { usedPercent: 0, resetsAt: null }, modelLimits: [] }), {
        headers: { "content-type": "application/json" },
      }));
    });
    const online = await page.evaluate(async () => (await fetch("/api/tasks/t-run/account-limits")).json());
    expect(online.fiveHour.usedPercent).toBe(28);
    await context.setOffline(true);
    const offline = await page.evaluate(async () => {
      try { return await (await fetch("/api/tasks/t-run/account-limits")).json(); } catch { return null; }
    });
    expect(offline).toBeNull();
  });
});

for (const width of [320, 360, 390]) {
  test(`allowance columns align and details stays touchable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 780 });
    const line = await show(page, claude);
    const x = async (text: string) => (await line.getByText(text, { exact: true }).boundingBox())!.x;
    await expect(line.getByText("72% left", { exact: true })).toBeVisible();
    expect(await x("5h")).toBe(await x("Weekly"));
    expect(await x("72% left")).toBe(await x("38% left"));
    expect(await x("Resets in 1h 40m")).toBe(await x("Resets in 3d"));
    const action = await line.getByRole("button", { name: "Account limit details" }).boundingBox();
    expect(action!.width).toBeGreaterThanOrEqual(44);
    expect(action!.height).toBeGreaterThanOrEqual(44);
    await assertViewportLocked(page);
    await page.route("**/api/tasks/t-idle-rich/account-limits", route => route.fulfill({ json: {
      ...claude, fiveHour: { usedPercent: null, resetsAt: reset }, sevenDay: { usedPercent: 95, resetsAt: now - 1000 },
    } }));
    await page.clock.fastForward(30000);
    await expect(line.getByText("Remaining unknown")).toBeVisible();
    await expect(line.getByText("Awaiting refresh")).toBeVisible();
    expect(await line.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await assertViewportLocked(page);
  });
}
