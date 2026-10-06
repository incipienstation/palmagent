import { test, expect, type Page } from "@playwright/test";
import { tasks } from "../fixtures.mjs";
import { assertViewportLocked } from "./_helpers";
import { PROGRESS_KEY, freshProgress } from "../../src/games/echo-garden/progress";

test.use({ serviceWorkers: "block" });

async function settings(page: Page) {
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  return page.getByRole("dialog", { name: "Settings", exact: true });
}
const game = (page: Page) => page.getByRole("dialog", { name: "Echo Garden", exact: true });
const plant = (page: Page, name: string) => game(page).getByRole("button", { name, exact: true });

test("Experimental ADHD mode gates play and preserves game progress, output preference, and the conversation draft", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/#/new");
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
  await prompt.fill("Keep this draft while I tend the garden");
  await prompt.evaluate(el => { el.dataset.gardenDraft = "mounted"; });
  await expect(page.getByRole("button", { name: "Open Echo Garden", exact: true })).toHaveCount(0);
  const panel = await settings(page);
  const toggle = panel.getByRole("switch", { name: "ADHD mode", exact: true });
  await expect(toggle).not.toBeChecked();
  await panel.getByRole("radio", { name: "Verbose output" }).click();
  await toggle.check();
  await expect(panel.getByRole("radio", { name: "Verbose output" })).toBeChecked();
  await panel.getByRole("button", { name: "Close settings" }).click();
  const launch = page.getByRole("button", { name: "Open Echo Garden", exact: true });
  await launch.click();
  await expect(game(page)).toBeVisible();
  await assertViewportLocked(page);
  const bounds = await plant(page, "Plant A: Bud").boundingBox();
  expect(bounds!.width).toBeGreaterThanOrEqual(44);
  expect(bounds!.height).toBeGreaterThanOrEqual(44);
  await plant(page, "Plant A: Bud").click();
  await expect(game(page).getByText("Garden in bloom! Level 2 is unlocked.")).toBeVisible();
  await game(page).getByRole("button", { name: "Next garden" }).click();
  await plant(page, "Plant A: Bud").click();
  await expect(plant(page, "Plant B: Bud")).toBeVisible();
  await expect(game(page).getByLabel("Pending echoes")).toHaveText("B +1 next turn");
  await game(page).getByRole("button", { name: "Let echoes arrive" }).focus();
  await page.keyboard.press("Space");
  await expect(game(page).getByText("Garden in bloom! Level 3 is unlocked.")).toBeVisible();
  await game(page).getByRole("button", { name: "Undo move" }).click();
  await expect(plant(page, "Plant B: Bud")).toBeVisible();
  await expect(game(page).getByLabel("Pending echoes")).toHaveText("B +1 next turn");
  await game(page).getByRole("button", { name: "Close game" }).click();
  await expect(launch).toBeFocused();
  await expect(prompt).toHaveAttribute("data-garden-draft", "mounted");
  await expect(prompt).toHaveValue("Keep this draft while I tend the garden");
  await page.reload();
  await launch.click();
  await expect(game(page).getByLabel("Pending echoes")).toHaveText("B +1 next turn");
  await expect(plant(page, "Plant B: Bud")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(game(page)).toHaveCount(0);
  await expect(launch).toBeFocused();
  await settings(page);
  await toggle.uncheck();
  await panel.getByRole("button", { name: "Close settings" }).click();
  await expect(launch).toHaveCount(0);
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(page.getByRole("button", { name: "Echo Garden", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(panel.getByRole("radio", { name: "Verbose output" })).toBeChecked();
  await toggle.check();
  await panel.getByRole("button", { name: "Close settings" }).click();
  await launch.click();
  await expect(game(page).getByLabel("Pending echoes")).toHaveText("B +1 next turn");
  await game(page).getByRole("button", { name: "Restart level" }).click();
  await expect(plant(page, "Plant A: Bud")).toBeVisible();
  await expect(game(page).getByLabel("Pending echoes")).toHaveText("No echoes on the way");
});

test("Echo Garden exposes live task attention and reconnect status without moving the board", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("pref:adhd-mode", "on");
    const NativeEventSource = window.EventSource;
    class InboxSource extends EventTarget {
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor(url: string | URL) {
        super();
        if (new URL(url, location.href).searchParams.get("snapshots") !== "1") return new NativeEventSource(url) as unknown as InboxSource;
        Object.assign(window, { gardenInbox: this });
        queueMicrotask(() => this.onopen?.(new Event("open")));
      }
      close() {}
    }
    window.EventSource = InboxSource as unknown as typeof EventSource;
  });
  await page.goto("/#/task/t-run");
  const current = structuredClone(tasks.find(task => task.taskId === "t-run")!);
  const emit = async (status: typeof current.status) => page.evaluate(task => {
    (window as unknown as { gardenInbox: EventSource }).gardenInbox.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "tasks", tasks: [task] }) }));
  }, { ...current, status });
  await expect.poll(() => page.evaluate(() => "gardenInbox" in window)).toBe(true);
  await emit("running");
  await page.getByRole("button", { name: "Open Echo Garden", exact: true }).click();
  await expect(game(page).getByText("Agent working", { exact: true })).toBeVisible();
  await plant(page, "Plant A: Bud").click();
  await game(page).getByRole("button", { name: "Next garden" }).click();
  await plant(page, "Plant A: Bud").click();
  await emit("awaiting_input");
  await expect(game(page).getByText("Agent needs your answer")).toBeVisible();
  await emit("awaiting_approval");
  await expect(game(page).getByText("Agent needs approval")).toBeVisible();
  await emit("idle");
  await expect(game(page).getByText("Agent is idle — review the conversation")).toBeVisible();
  await page.evaluate(() => (window as unknown as { gardenInbox: EventSource }).gardenInbox.onerror?.(new Event("error")));
  await expect(game(page).getByText("Reconnecting — task status may be out of date")).toBeVisible();
  await expect(game(page).getByLabel("Pending echoes")).toHaveText("B +1 next turn");
  await game(page).getByRole("button", { name: "Return to task" }).click();
  await expect(game(page)).toHaveCount(0);
  await expect(page).toHaveURL(/#\/task\/t-run$/);
});

test("Echo Garden's final level fits desktop and short mobile screens and remains reachable from navigation", async ({ page }) => {
  await page.addInitScript(({ key, progress }) => {
    localStorage.setItem("pref:adhd-mode", "on");
    localStorage.setItem(key, JSON.stringify(progress));
  }, { key: PROGRESS_KEY, progress: { ...freshProgress(), level: 11, unlocked: 12 } });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?__theme=light");
  const launch = page.getByRole("button", { name: "Echo Garden", exact: true });
  await launch.click();
  await expect(game(page).getByRole("combobox", { name: "Garden level" })).toContainText("12. The whole garden");
  await expect(game(page).getByRole("group", { name: "Garden plants" }).getByRole("button")).toHaveCount(6);
  await assertViewportLocked(page);
  await page.setViewportSize({ width: 320, height: 480 });
  expect(await game(page).evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect(game(page).getByRole("button", { name: "Close game" })).toBeInViewport();
  await expect(game(page).getByRole("button", { name: "Let echoes arrive" })).toBeInViewport();
  await game(page).getByRole("button", { name: "How to play" }).click();
  await expect(game(page).getByText(/Each tap grows a plant/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(game(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await launch.click();
  await expect(game(page)).toBeVisible();
  await game(page).getByRole("button", { name: "Close game" }).click();
  await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toBeFocused();
});
