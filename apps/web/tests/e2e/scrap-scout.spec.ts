import { test, expect, type Page } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";
import { SAVE_KEY } from "../../src/games/scrap-scout/engine";
import { tasks } from "../fixtures.mjs";

test.use({ serviceWorkers: "block" });
const game = (page: Page) => page.getByRole("dialog", { name: "Scrap Scout", exact: true });
const launch = (page: Page) => page.getByRole("button", { name: "Open Scrap Scout", exact: true });

test("Phaser play is opt-in, keyboard operable, and preserves drafts and atomic shot saves", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto("/#/new");
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
  await prompt.fill("Keep my draft while I explore");
  await prompt.evaluate(el => el.dataset.scrapDraft = "mounted");
  await expect(launch(page)).toHaveCount(0);
  await expect(page.locator("canvas")).toHaveCount(0);
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("radio", { name: "Verbose output" }).click();
  await settings.getByRole("switch", { name: "ADHD mode" }).check();
  await expect(settings.getByRole("radio", { name: "Verbose output" })).toBeChecked();
  await settings.getByRole("button", { name: "Close settings" }).click();
  await launch(page).click();
  const fire = game(page).getByRole("button", { name: "Fire", exact: true });
  await expect(fire).toBeEnabled();
  await expect(game(page).locator("canvas")).toHaveCount(1);
  await assertViewportLocked(page);
  await fire.focus(); await page.keyboard.press("Enter");
  await expect(game(page).getByRole("region", { name: "Choose an upgrade" })).toBeVisible();
  await expect(game(page).getByRole("button", { name: /Split shot/ })).toBeInViewport();
  await game(page).getByRole("button", { name: /Split shot/ }).click();
  await expect(game(page).getByText("2 / 4 · Crossfire")).toBeVisible();
  const aim = game(page).getByRole("slider", { name: "Aim angle" });
  await aim.focus(); await page.keyboard.press("ArrowRight");
  await expect(aim).toHaveValue("1");
  const canvas = game(page).locator("canvas");
  await canvas.click({ position: { x: 50, y: 100 } });
  await expect(aim).not.toHaveValue("1");
  await fire.click();
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)!).total, SAVE_KEY)).toBe(2);
  await game(page).getByRole("button", { name: "Close game" }).click();
  await expect(page.locator("canvas")).toHaveCount(0);
  await expect(prompt).toHaveAttribute("data-scrap-draft", "mounted");
  await expect(prompt).toHaveValue("Keep my draft while I explore");
  await expect(launch(page)).toBeFocused();
  const saved = await page.evaluate(key => localStorage.getItem(key), SAVE_KEY);
  await page.reload(); await launch(page).click();
  await expect(fire).toBeEnabled();
  expect(await page.evaluate(key => localStorage.getItem(key), SAVE_KEY)).toBe(saved);
  await game(page).getByRole("button", { name: "Restart expedition" }).click();
  await game(page).getByRole("button", { name: "Keep playing" }).click();
  await expect(game(page).getByText("2 / 4 · Crossfire")).toBeVisible();
  await game(page).getByRole("button", { name: "Restart expedition" }).click();
  await game(page).getByRole("button", { name: "Restart", exact: true }).click();
  await expect(game(page).getByText("1 / 4 · The scrapyard")).toBeVisible();
});

test("live attention and reconnect messages preserve the board, and a failed sprite load can retry", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("pref:adhd-mode", "on");
    const NativeSource = window.EventSource;
    class Inbox extends EventTarget {
      onopen: ((e: Event) => void) | null = null;
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: Event) => void) | null = null;
      constructor(url: string | URL) {
        super();
        if (new URL(url, location.href).searchParams.get("snapshots") !== "1") return new NativeSource(url) as unknown as Inbox;
        Object.assign(window, { scrapInbox: this }); queueMicrotask(() => this.onopen?.(new Event("open")));
      }
      close() {}
    }
    window.EventSource = Inbox as unknown as typeof EventSource;
  });
  await page.route("**/scouts-*.png", route => route.abort());
  await page.goto("/#/task/t-run"); await launch(page).click();
  await expect(game(page).getByText("The game could not load.", { exact: false })).toBeVisible();
  await page.unroute("**/scouts-*.png");
  await game(page).getByRole("button", { name: "Retry game" }).click();
  await expect(game(page).getByRole("button", { name: "Fire", exact: true })).toBeEnabled();
  const saved = await page.evaluate(key => localStorage.getItem(key), SAVE_KEY);
  const current = structuredClone(tasks.find(t => t.taskId === "t-run")!);
  for (const [status, text] of [["awaiting_input", "Agent needs your answer"], ["awaiting_approval", "Agent needs approval"], ["idle", "Agent is idle"]] as const) {
    await page.evaluate(task => (window as unknown as { scrapInbox: EventSource }).scrapInbox.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "tasks", tasks: [task] }) })), { ...current, status });
    await expect(game(page).getByText(text, { exact: true })).toBeVisible();
  }
  await page.evaluate(() => (window as unknown as { scrapInbox: EventSource }).scrapInbox.onerror?.(new Event("error")));
  await expect(game(page).getByText("Reconnecting — task status may be out of date")).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), SAVE_KEY)).toBe(saved);
  await expect(game(page).locator("canvas")).toHaveCount(1);
});

test("game navigation fits short mobile screens and returns to a task needing attention", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pref:adhd-mode", "on"));
  await page.setViewportSize({ width: 320, height: 480 });
  await page.goto("/#/task/t-run");
  await launch(page).click();
  await expect(game(page).getByRole("button", { name: "Fire", exact: true })).toBeEnabled();
  await expect(game(page).getByRole("button", { name: "Close game" })).toBeInViewport();
  await expect(game(page).getByRole("button", { name: "Fire", exact: true })).toBeInViewport();
  expect(await game(page).evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await game(page).getByRole("button", { name: "Return to task" }).click();
  await expect(game(page)).toHaveCount(0);
  await expect(page.locator("canvas")).toHaveCount(0);
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Scrap Scout", exact: true }).click();
  await expect(game(page).getByRole("button", { name: "Fire", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(game(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toBeFocused();
});
