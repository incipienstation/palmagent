import { expect, test, type Page } from "@playwright/test";
import { tasks } from "../fixtures.mjs";
import { freshRun, SAVE_KEY, serialize, WORLD_W } from "../../src/games/scrap-survivor/engine";
import { installScopedStream, open as openSession, send } from "./_session-stream";
import { assertViewportLocked } from "./_helpers";
test.use({ serviceWorkers: "block" });
const game = (page: Page) => page.getByRole("dialog", { name: "Scrap Survivor", exact: true });
const saved = (page: Page) => page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY);
const enable = (page: Page) => page.addInitScript(() => localStorage.setItem("pref:adhd-mode", "on"));
const open = (page: Page) => page.getByRole("button", { name: "Open Scrap Survivor", exact: true }).click();

test("a first send opens before the response and preserves the canvas through task identity replacement and Back", async ({ page }) => {
  await enable(page); await installScopedStream(page); await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/tasks/t-run/history?**", route => route.fulfill({ json: { events: [], before: null, cursor: 0 } }));
  let release!: () => void; const gate = new Promise<void>(r => release = r);
  const task = { ...tasks.find(t => t.taskId === "t-run")!, prompt: "Explore while sending" };
  await page.route("**/api/tasks", async route => { if (route.request().method() !== "POST") return route.continue(); await gate; await route.fulfill({ status: 201, json: { task } }); });
  await page.goto("/#/new/space/repo-app");
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true }); await prompt.fill("Explore while sending");
  const input = await prompt.elementHandle();
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  try {
    await expect(game(page)).toBeVisible(); await expect(game(page).getByText("Sending your message…")).toBeVisible();
    await expect(game(page).getByRole("button", { name: "Movement joystick", exact: true })).toBeEnabled();
    const canvas = await game(page).locator("canvas").elementHandle();
    release(); await expect(page).toHaveURL(/task\/t-run$/);
    await expect(game(page)).toBeVisible();
    expect(await canvas!.evaluate(el => el.isConnected && el === document.querySelector('canvas'))).toBe(true);
    expect(await input!.evaluate(el => el === document.querySelector('textarea'))).toBe(true);
    await assertViewportLocked(page);
    await page.goBack(); await expect(game(page)).toHaveCount(0); await expect(page).toHaveURL(/task\/t-run$/);
    await expect(page.locator("canvas")).toHaveCount(0);
    await open(page); await expect(game(page)).toBeVisible(); await page.keyboard.press("Escape"); await expect(game(page)).toHaveCount(0);
  } finally { release(); }
});

test("follow-up send opens immediately; failure pauses play and retains the draft", async ({ page }) => {
  await enable(page);
  let release!: () => void; const gate = new Promise<void>(r => release = r);
  await page.route("**/api/tasks/t-idle-rich/messages", async route => { await gate; await route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } }); });
  await page.goto("/#/task/t-idle-rich");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Preserve this follow-up");
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  try { await expect(game(page)).toBeVisible(); release(); await expect(game(page).getByText("Message delivery needs attention")).toBeVisible();
    await expect(game(page).getByRole("button", { name: "Movement joystick" })).toBeDisabled();
    await game(page).getByRole("button", { name: "Back to chat" }).click();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Preserve this follow-up");
  } finally { release(); }
});

test("opt-in controls, movement, pause, persistence, upgrades and short-screen controls", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 }); await page.goto("/#/new/space/repo-app");
  await expect(page.getByRole("button", { name: "Open Scrap Survivor" })).toHaveCount(0);
  await page.getByRole("button", { name: "Open navigation", exact: true }).click(); await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true }); await settings.getByRole("switch", { name: "ADHD mode" }).check(); await settings.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("Keep my draft"); await open(page);
  await expect(game(page).getByRole("button", { name: "Movement joystick" })).toBeEnabled();
  await page.keyboard.down("ArrowRight"); await expect.poll(async () => (await saved(page))?.player.x).toBeGreaterThan(WORLD_W / 2 + 60); await page.keyboard.up("ArrowRight");
  await game(page).getByRole("button", { name: "Pause game" }).click();
  await expect(game(page).getByText("Paused", { exact: true })).toBeVisible();
  await game(page).getByRole("button", { name: "Close game" }).click();
  const checkpoint = await saved(page); await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("Keep my draft");
  await expect(page.getByRole("button", { name: "Open Scrap Survivor" })).toBeFocused();
  await expect(page.locator("canvas")).toHaveCount(0);
  await page.reload(); await open(page); await expect(game(page).getByRole("button", { name: "Movement joystick" })).toBeEnabled();
  expect((await saved(page)).time).toBeGreaterThanOrEqual(checkpoint.time);
  await page.evaluate(() => window.dispatchEvent(new Event("blur"))); await expect(game(page).getByText("Paused while away", { exact: true })).toBeVisible();
  await game(page).getByRole("button", { name: "Continue playing" }).click();
  await page.setViewportSize({ width: 320, height: 480 });
  await expect(game(page).getByRole("button", { name: "Close game" })).toBeInViewport(); await expect(game(page).getByRole("button", { name: "Movement joystick" })).toBeInViewport();
  await game(page).getByRole("button", { name: "Restart expedition" }).click(); await game(page).getByRole("button", { name: "Restart", exact: true }).click();
  await game(page).getByRole("button", { name: "Close game" }).click();
  const run = freshRun(1); run.level = 2; run.choices = ["blade", "arc", "bolt"];
  await page.evaluate(({key,value}) => localStorage.setItem(key,value), {key:SAVE_KEY,value:serialize(run)});
  await page.reload(); await open(page); await expect(game(page).getByRole("region", { name: "Choose an upgrade" })).toBeVisible();
  await game(page).getByRole("button", { name: /Orbiting blades/ }).click(); await expect.poll(async () => (await saved(page)).upgrades.blade).toBe(1);
});

test("sprite loading can retry and new attention returns to chat without resetting the run", async ({ page }) => {
  await enable(page);
  await page.addInitScript(() => {
    const Native = window.EventSource;
    class Inbox extends EventTarget {
      onopen: ((e: Event) => void) | null = null; onmessage: ((e: MessageEvent) => void) | null = null; onerror: ((e: Event) => void) | null = null;
      constructor(url: string | URL) { super(); if (new URL(url, location.href).searchParams.get("snapshots") !== "1") return new Native(url) as unknown as Inbox;
        Object.assign(window, { survivorInbox: this }); queueMicrotask(() => this.onopen?.(new Event("open"))); }
      close() {}
    }
    window.EventSource = Inbox as unknown as typeof EventSource;
  });
  await installScopedStream(page);
  await page.route("**/units-*.webp", route => route.abort());
  await page.goto("/#/task/t-run"); await open(page);
  await expect(game(page).getByText("The game could not load.")).toBeVisible();
  await page.unroute("**/units-*.webp"); await game(page).getByRole("button", { name: "Retry game" }).click();
  await expect(game(page).getByRole("button", { name: "Movement joystick" })).toBeEnabled();
  const task = tasks.find(t => t.taskId === "t-run")!;
  for (const status of ["awaiting_input", "awaiting_approval"] as const) {
    await page.evaluate(t => (window as unknown as { survivorInbox: EventSource }).survivorInbox.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "tasks", tasks: [t] }) })), { ...task, status });
    await expect(game(page)).toHaveCount(0);
    const checkpoint = await saved(page);
    await open(page);
    await expect(game(page).getByRole("button", { name: "Movement joystick" })).toBeEnabled();
    expect((await saved(page)).time).toBeGreaterThanOrEqual(checkpoint.time);
  }
  await page.evaluate(() => (window as unknown as { survivorInbox: EventSource }).survivorInbox.onerror?.(new Event("error")));
  await expect(game(page).getByText("Reconnecting — task status may be out of date")).toBeVisible();
  await expect(game(page).locator("canvas")).toHaveCount(1);
});

test.describe("touch joystick", () => {
  test.use({ hasTouch: true });
  test("arena dragging moves diagonally, ignores extra fingers, and releases on cancel or pause", async ({ page, context }) => {
    await enable(page); await page.setViewportSize({ width: 390, height: 844 });
    const run = freshRun(9); run.enemies = []; run.spawn = 10;
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: SAVE_KEY, value: serialize(run) });
    await page.goto("/#/task/t-run"); await open(page);
    const joystick = game(page).getByRole("button", { name: "Movement joystick" });
    await expect(joystick).toBeEnabled(); await expect(joystick).toBeInViewport();
    await expect(game(page).getByRole("button", { name: /^Move (up|down|left|right)$/ })).toHaveCount(0);
    // Capture the resting position after the sheet finishes entering the viewport.
    await game(page).evaluate(async el => {
      await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
    });
    const resting = await joystick.boundingBox();
    const arena = await game(page).getByTestId("survivor-arena").boundingBox();
    const start = { x: arena!.x + arena!.width / 2, y: arena!.y + arena!.height * 0.8 };
    const touch = await context.newCDPSession(page);
    const point = (id: number, x: number, y: number) => ({ id, x, y });
    const upper = { x: start.x, y: arena!.y + arena!.height * 0.4 };
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(7, upper.x, upper.y)] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(7, upper.x + 65, upper.y)] });
    await page.waitForTimeout(1100);
    expect((await saved(page)).player).toEqual(run.player);
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(1, start.x, start.y)] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(1, start.x + 65, start.y - 65)] });
    await expect.poll(async () => (await saved(page))?.player.x).toBeGreaterThan(run.player.x + 20);
    expect((await saved(page)).player.y).toBeLessThan(run.player.y - 20);
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(1, start.x + 65, start.y - 65), point(2, start.x - 70, start.y + 70)] });
    const active = await joystick.boundingBox();
    expect(active!.x + active!.width / 2).toBeCloseTo(start.x, 0);
    expect(active!.y + active!.height / 2).toBeCloseTo(start.y, 0);
    await touch.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await expect.poll(async () => (await joystick.boundingBox())!.y).toBeCloseTo(resting!.y, 0);
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(4, start.x, start.y)] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(4, start.x - 45, start.y)] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(async () => (await joystick.boundingBox())!.y).toBeCloseTo(resting!.y, 0);
    await page.waitForTimeout(1100); const released = (await saved(page)).player;
    await page.waitForTimeout(1100); expect((await saved(page)).player).toEqual(released);
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(3, start.x, start.y)] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(3, start.x - 50, start.y)] });
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(joystick).toBeDisabled();
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await game(page).getByRole("button", { name: "Continue playing" }).click();
    await expect(joystick).toBeEnabled();
    await page.waitForTimeout(1100); const resumed = (await saved(page)).player;
    await page.waitForTimeout(1100); expect((await saved(page)).player).toEqual(resumed);
    await assertViewportLocked(page);
  });
});

test("illustrated upgrades stay reachable on short screens and repair the visible HP meter", async ({ page }) => {
  await enable(page); await page.setViewportSize({ width: 320, height: 480 });
  const run = freshRun(4); run.hull = 2; run.level = 6; run.enemies = []; run.spawn = 10;
  run.upgrades = { bolt: 1, blade: 1, arc: 1, reactor: 1, magnet: 1, boots: 1 };
  run.choices = ["reactor", "magnet", "boots"];
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: SAVE_KEY, value: serialize(run) });
  await page.goto("/#/task/t-run"); await open(page);
  const panel = game(page), choices = panel.getByRole("region", { name: "Choose an upgrade" });
  await expect(choices).toBeVisible();
  await expect(panel.getByRole("meter", { name: "Player HP" })).toHaveAttribute("aria-valuenow", "2");
  await expect(choices.locator("button svg image")).toHaveCount(3);
  await expect(panel.getByLabel("Equipped upgrades").getByRole("img")).toHaveCount(6);
  await choices.getByRole("button", { name: /Turbo treads/ }).click();
  await expect(choices).toHaveCount(0);
  await expect(panel.getByRole("meter", { name: "Player HP" })).toHaveAttribute("aria-valuenow", "4");
  await expect(panel.getByRole("img", { name: "Turbo treads level 2", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Movement joystick" })).toBeInViewport();
  await assertViewportLocked(page);
});


test("progress leaves the game open; final reply returns once while preserving draft and run", async ({ page }) => {
  await enable(page); await installScopedStream(page); await openSession(page, "t-run");
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Keep this draft while I play");
  await open(page);
  await expect(game(page).getByRole("button", { name: "Movement joystick" })).toBeEnabled();
  await page.keyboard.down("ArrowRight");
  await expect.poll(async () => (await saved(page))?.player.x).toBeGreaterThan(WORLD_W / 2 + 30);
  const emit = (seq: number, kind: string, payload: unknown, taskId = "t-run") => send(page, "t-run", {
    type: "event", event: { taskId, agent: "codex", ts: seq, kind, payload },
  }, seq);
  await emit(1, "tool_call", { name: "exec", input: {} });
  await emit(2, "assistant_text", { text: "Other conversation", messageId: "other" }, "t-idle-rich");
  await emit(3, "assistant_text", { text: "  ", messageId: "reply", phase: "progress" });
  await expect(game(page)).toBeVisible();
  const moving = (await saved(page)).player.x;
  await emit(4, "assistant_text", { text: "I found the cause", messageId: "reply", phase: "progress" });
  await emit(5, "assistant_text", { text: ", and am fixing it.", messageId: "reply", phase: "progress" });
  await expect.poll(async () => (await saved(page)).player.x).toBeGreaterThan(moving + 20);
  await expect(game(page)).toBeVisible();
  await emit(6, "assistant_text", { text: "The fix is ready.", messageId: "final", phase: "final" });
  await expect(game(page)).toHaveCount(0);
  await page.keyboard.up("ArrowRight");
  await expect(page.locator("canvas")).toHaveCount(0);
  await expect(draft).toHaveValue("Keep this draft while I play");
  await expect(draft).not.toBeFocused();
  await expect(page.getByRole("button", { name: "Open Scrap Survivor", exact: true })).toBeFocused();
  const checkpoint = await saved(page);
  await page.waitForTimeout(1100);
  expect(await saved(page)).toEqual(checkpoint);
  await open(page);
  await expect(game(page).getByRole("button", { name: "Movement joystick" })).toBeEnabled();
  await emit(6, "assistant_text", { text: "The fix is ready.", messageId: "final", phase: "final" });
  await emit(7, "assistant_text", { text: " All done.", messageId: "final", phase: "final" });
  await emit(8, "result", { result: "The fix is ready. All done." });
  await expect(game(page)).toBeVisible();
  expect((await saved(page)).time).toBeGreaterThanOrEqual(checkpoint.time);
});

test("scoped attention closes only for a new request, even when the inbox is unchanged", async ({ page }) => {
  await enable(page); await installScopedStream(page); await openSession(page, "t-run");
  const task = tasks.find(t => t.taskId === "t-run")!;
  await open(page);
  const snapshot = (status: string, taskId = "t-run") => send(page, "t-run", { type: "tasks", tasks: [{ ...task, taskId, status }] });
  await snapshot("awaiting_input", "t-idle-rich");
  await expect(game(page)).toBeVisible();
  await snapshot("awaiting_input");
  await expect(game(page)).toHaveCount(0);
  await open(page); await snapshot("awaiting_input");
  await expect(game(page).getByRole("button", { name: "Movement joystick" })).toBeEnabled();
  await snapshot("awaiting_approval");
  await expect(game(page)).toHaveCount(0);
  await open(page); await snapshot("awaiting_approval");
  await expect(game(page)).toBeVisible();
});


for (const phase of ["progress", "final"] as const) test(`new-task history with ${phase} prose only returns for a final reply`, async ({ page }) => {
  await enable(page); await installScopedStream(page);
  const task = tasks.find(t => t.taskId === "t-run")!;
  await page.route("**/api/tasks", async route => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({ status: 201, json: { task } });
  });
  await page.route("**/api/tasks/t-run/history?**", route => route.fulfill({ json: {
    events: [{ seq: 1, event: { taskId: "t-run", agent: "codex", ts: 1, kind: "assistant_text",
      payload: { text: "A quick reply", messageId: "first", phase } } }], before: null, cursor: 1,
  } }));
  await page.goto("/#/new/space/repo-app");
  await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("A quick reply");
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  await expect(page).toHaveURL(/task\/t-run$/);
  if (phase === "progress") {
    await expect(game(page).getByRole("button", { name: "Movement joystick" })).toBeEnabled();
    await game(page).getByRole("button", { name: "Close game" }).click();
  } else await expect(game(page)).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).not.toBeFocused();
  await open(page);
  await expect(game(page).getByRole("button", { name: "Movement joystick" })).toBeEnabled();
});


test("a reply recovered after reconnect returns once and does not replay on reopening", async ({ page }) => {
  await enable(page); await installScopedStream(page); await openSession(page, "t-run");
  const task = tasks.find(t => t.taskId === "t-run")!;
  await page.route("**/api/tasks/t-run/history/changes?**", route => route.fulfill({ json: {
    after: 0, through: 10, nextAfter: null,
    events: [{ seq: 10, event: { taskId: "t-run", agent: "codex", ts: 10, kind: "assistant_text",
      payload: { text: "Reply received during reconnect", messageId: "recovered", phase: "final" } } }],
  } }));
  await open(page);
  await send(page, "t-run", { type: "tasks", tasks: [task], historyThrough: 10 });
  await expect(game(page)).toHaveCount(0);
  await open(page);
  await send(page, "t-run", { type: "tasks", tasks: [task], historyThrough: 10 });
  await send(page, "t-run", { type: "event", event: { taskId: "t-run", agent: "codex", ts: 11,
    kind: "assistant_text", payload: { text: " continued", messageId: "recovered", phase: "final" } } }, 11);
  await expect(game(page).getByRole("button", { name: "Movement joystick" })).toBeEnabled();
});


test("late final classification returns to chat; unclassified text and progress markers keep playing", async ({ page }) => {
  await enable(page); await installScopedStream(page); await openSession(page, "t-run");
  await open(page);
  const emit = (seq: number, kind: string, payload: unknown) => send(page, "t-run", {
    type: "event", event: { taskId: "t-run", agent: "claude", ts: seq, kind, payload },
  }, seq);
  await emit(1, "assistant_text", { text: "Checking the files", messageId: "work" });
  await emit(2, "status", { subtype: "assistant_message", messageId: "work", phase: "progress" });
  await emit(3, "assistant_text", { text: "Finished the fix", messageId: "answer" });
  await expect(game(page).getByRole("button", { name: "Movement joystick" })).toBeEnabled();
  await emit(4, "status", { subtype: "assistant_message", messageId: "answer", phase: "final" });
  await expect(game(page)).toHaveCount(0);
  await open(page);
  await emit(5, "result", { result: "Finished the fix" });
  await expect(game(page).getByRole("button", { name: "Movement joystick" })).toBeEnabled();
});
