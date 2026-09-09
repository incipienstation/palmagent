import { test, expect, type Page } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";

// Exercise the real SSE consumer so replay, missing fields and a newer report
// all reach the statusline through the same path as a running dispatcher.
async function reports(page: Page, payloads: unknown[], agent = "codex") {
  await page.route("**/api/stream?task=t-run", async (route) => {
    const body = payloads.map((payload, i) => {
      const event = { taskId: "t-run", agent, kind: "result", payload, ts: i };
      return `id: ${i + 1}\ndata: ${JSON.stringify({ type: "event", event })}\n\n`;
    }).join("");
    await route.fulfill({ contentType: "text/event-stream", body });
  });
  await page.goto("/#/task/t-run");
  return page.getByRole("region", { name: "Task usage" });
}

test("usage is visible above the mobile composer", async ({ page }) => {
  await page.goto("/#/task/t-idle-rich");
  const line = page.getByRole("region", { name: "Task usage" });
  await expect(line.getByText("Input 18.2K", { exact: true })).toBeVisible();
  await expect(line.getByText("Output 2.9K", { exact: true })).toBeVisible();
  await expect(line.getByText(/Reported cost/)).toHaveCount(0);
  await assertViewportLocked(page);
});

test("shows the latest report without summing cached or reasoning subsets", async ({ page }) => {
  const line = await reports(page, [
    { usage: { input_tokens: 999, output_tokens: 999 } },
    { usage: { input_tokens: 12000, cached_input_tokens: 8000, output_tokens: 200, reasoning_output_tokens: 100 } },
  ]);
  await expect(line.getByText("Input 12K", { exact: true })).toBeVisible();
  await expect(line.getByText("Cache read 8K", { exact: true })).toBeVisible();
  await expect(line.getByText("Output 200", { exact: true })).toBeVisible();
  await expect(line.getByText("Reasoning 100", { exact: true })).toBeVisible();
  await expect(line.getByText("Current turn usage arrives when the turn finishes.")).toBeVisible();
  await assertViewportLocked(page);
});

test("renders Claude cache counters and a reported zero separately from missing data", async ({ page }) => {
  const line = await reports(page, [{ total_cost_usd: 0, usage: {
    input_tokens: 0, output_tokens: 42, cache_read_input_tokens: 15000, cache_creation_input_tokens: 500,
  } }], "claude");
  await expect(line.getByText("Input 0", { exact: true })).toBeVisible();
  await expect(line.getByText("Cache read 15K", { exact: true })).toBeVisible();
  await expect(line.getByText("Cache write 500", { exact: true })).toBeVisible();
  await expect(line.getByText("Reported cost $0.00", { exact: true })).toBeVisible();
  await assertViewportLocked(page);
});

test("a malformed latest report clears old numbers instead of inventing zero usage", async ({ page }) => {
  const line = await reports(page, [
    { usage: { input_tokens: 12345 } },
    { total_cost_usd: -1, usage: { input_tokens: "100", output_tokens: -2, cached_input_tokens: null } },
  ]);
  await expect(line.getByText("Waiting for usage report…")).toBeVisible();
  await expect(line.getByText(/^Input /)).toHaveCount(0);
  await expect(line.getByText(/Reported cost/)).toHaveCount(0);
});
