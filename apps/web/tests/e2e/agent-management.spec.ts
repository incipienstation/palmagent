import { installReadStreams, changeRead } from "./_read-streams";
import { expect, test } from "@playwright/test";
import { usage } from "../fixtures.mjs";

const installation = (agent: "claude" | "codex") => ({ agent,
  version: agent === "claude" ? "2.1.275" : "0.156.1", latestVersion: agent === "claude" ? "2.1.276" : "0.156.2",
  installation: "native", compatible: true, checkedAt: Date.now(), releaseState: "ready", update: { state: "idle" },
});

test("Agents uses consistent metrics, preserves zero versus missing, and keeps account allowance separate", async ({ page }) => {
  await page.route("**/api/usage", route => route.fulfill({ json: { usage: usage.map(item => ({ ...item, totalCostUsd: 0,
    reported: item.agent === "claude" ? ["totalCostUsd"] : ["inputTokens", "cachedInputTokens", "outputTokens"] })) } }));
  await page.goto("/#/agents");
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
  for (const name of ["Claude Code", "Codex"]) {
    const card = page.getByRole("region", { name, exact: true });
    await expect(card.getByText("72% left")).toBeVisible();
    await expect(card.getByText("Installed version")).toBeVisible();
    await expect(card.getByText("Reported cost")).toBeVisible();
    await expect(card.getByText("Input tokens")).toBeVisible();
    await expect(card.getByText("Active time")).toBeVisible();
  }
  await expect(page.getByRole("region", { name: "Claude Code", exact: true }).getByText("$0", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Codex", exact: true }).getByLabel("Reported cost: not reported")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto("/#/usage");
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
});

test("refresh and navigation never update; an explicit update remains visible after reload and verifies its result", async ({ page }) => {
  await installReadStreams(page);
  let posts = 0, state = "idle", version = "0.156.1";
  await page.route("**/api/agents", route => route.fulfill({ json: { canUpdate: true, installations: [installation("claude"), {
    ...installation("codex"), version, update: { state, ...(state === "succeeded" ? { message: "Updated from 0.156.1 to 0.156.2." } : {}) },
  }] } }));
  await page.route("**/api/agents/codex/update", async route => {
    posts++; expect(route.request().postDataJSON()).toEqual({ expectedVersion: "0.156.1" });
    state = "running";
    await route.fulfill({ status: 202, json: { ...installation("codex"), update: { state } } });
  });
  await page.goto("/#/agents");
  const update = page.getByRole("button", { name: "Update Codex", exact: true });
  await expect(update).toBeEnabled();
  await page.getByRole("button", { name: "Refresh agents" }).click();
  await expect(update).toBeEnabled(); expect(posts).toBe(0);
  await update.click();
  const confirm = page.getByRole("alertdialog", { name: "Update Codex?" });
  await expect(confirm).toContainText("configured release channel");
  await confirm.getByRole("button", { name: "Update Codex", exact: true }).click();
  await expect(update).toBeDisabled();
  await page.reload();
  await expect(update).toBeDisabled();
  await expect(page.getByRole("region", { name: "Codex", exact: true }).getByRole("status")).toHaveText("Updating…");
  state = "succeeded"; version = "0.156.2";
  await changeRead(page, "/api/agents/stream");
  await expect(page.getByText("Updated from 0.156.1 to 0.156.2.")).toBeVisible();
  expect(posts).toBe(1);
});

test("failed installation reads preserve displayed versions and disable stale update actions", async ({ page }) => {
  let fail = false;
  await page.route("**/api/agents", route => route.fulfill(fail
    ? { status: 503, json: { error: "Temporarily unavailable" } }
    : { json: { canUpdate: true, installations: [installation("claude"), installation("codex")] } }));
  await page.goto("/#/agents");
  const update = page.getByRole("button", { name: "Update Codex", exact: true });
  await expect(update).toBeEnabled();
  fail = true;
  await page.getByRole("button", { name: "Refresh agents" }).click();
  await expect(page.getByRole("alert")).toContainText("Couldn’t load agent installations");
  await expect(update).toBeDisabled();
  await expect(page.getByText("0.156.1", { exact: true })).toBeVisible();
});

test("installation and allowance reads remain idle until SSE changes or reconnects", async ({ page }) => {
  await installReadStreams(page);
  await page.clock.install();
  let installations = 0, limits = 0, used = 28;
  await page.route("**/api/agents", route => {
    installations++;
    return route.fulfill({ json: { canUpdate: true, installations: [installation("codex")] } });
  });
  await page.route("**/api/agents/codex/limits", route => {
    limits++;
    return route.fulfill({ json: { agent: "codex", state: "ready", checkedAt: Date.now(), buckets: [
      { id: "codex", primary: { usedPercent: used, windowMinutes: 300, resetsAt: null } },
    ] } });
  });
  await page.goto("/#/agents");
  const card = page.getByRole("region", { name: "Codex", exact: true });
  await expect(card.getByText("72% left")).toBeVisible();
  // Finish any initial subscription revalidation before measuring idle traffic.
  await changeRead(page, "/api/agents/stream");
  await changeRead(page, "/api/agents/codex/limits/stream");
  await expect(page.getByRole("button", { name: "Refresh agents" })).toBeEnabled();
  const before = { installations, limits };
  await page.clock.fastForward(600_000);
  expect({ installations, limits }).toEqual(before);
  used = 40;
  await changeRead(page, "/api/agents/codex/limits/stream", true);
  await expect(card.getByText("60% left")).toBeVisible();
  expect(installations).toBe(before.installations);
  await page.evaluate(() => { location.hash = "#/spaces"; });
  await expect.poll(() => page.evaluate(() => (window as unknown as { readStreams: Map<string, unknown> }).readStreams.size)).toBe(0);
});
