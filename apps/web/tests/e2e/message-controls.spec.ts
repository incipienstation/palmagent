import { test, expect, type Locator, type Page } from "@playwright/test";
import { tasks } from "../fixtures.mjs";
import type { MessageQueue } from "@palmagent/shared";
import { installScopedStream, open, send } from "./_scoped-stream";

async function hold(page: Page, button: Locator) {
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.waitForTimeout(520); await page.mouse.up();
}
async function setup(page: Page) {
  await installScopedStream(page);
  await page.addInitScript(() => {
    Object.assign(window, { vibrations: [] });
    Object.defineProperty(navigator, "vibrate", { configurable: true, value: (ms: number) => { (window as any).vibrations.push(ms); return true; } });
  });
  const state: MessageQueue = { revision: 1, paused: false, runId: "run-1", messages: [] };
  const calls: any[] = [];
  await page.route("**/api/tasks/t-run/messages**", async route => {
    const req = route.request().postDataJSON(); calls.push(req);
    if (req.mode === "queue") state.messages.push({ id: req.clientMessageId, version: 1, status: "queued", mode: "queue", text: req.text, images: req.images });
    if (req.action === "save") { state.messages[0].text = req.text; state.messages[0].version++; delete state.messages[0].editingUntil; }
    if (req.action === "edit" || req.action === "renew") state.messages[0].editingUntil = Date.now() + 60000;
    if (req.action === "release") delete state.messages[0].editingUntil;
    if (req.action === "delete" || req.action === "send") state.messages.shift();
    state.revision++;
    await route.fulfill({ json: state });
  });
  await open(page, "t-run");
  await send(page, "t-run", { type: "tasks", tasks: [{ ...tasks.find(t => t.taskId === "t-run")!, messageQueue: state }], replayThrough: 0 });
  return { calls, state };
}

test("long press opens a haptic toggle without sending; selection applies to one draft", async ({ page }) => {
  const { calls } = await setup(page);
  await page.getByRole("textbox").fill("Do this later");
  await hold(page, page.getByRole("button", { name: "Send now", exact: true }));
  await expect(page.getByRole("radiogroup", { name: "Message delivery mode" })).toBeVisible();
  expect(calls).toHaveLength(0);
  await page.getByRole("radio", { name: "Queue", exact: true }).click();
  expect(calls).toHaveLength(0);
  await expect(page.getByRole("button", { name: "Add to queue" })).toBeFocused();
  await page.getByRole("button", { name: "Add to queue" }).click();
  await expect(page.getByRole("button", { name: /Queued message 1: Do this later/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send now", exact: true })).toBeVisible();
  expect(calls[0].mode).toBe("queue");
  expect(await page.evaluate(() => (window as any).vibrations)).toEqual([12, 6]);
  await expect(page).toHaveScreenshot("message-queue.png");
});

test("queue editing saves in place and restores the ordinary draft", async ({ page }) => {
  const { calls } = await setup(page);
  await page.getByRole("textbox").fill("Original queued prompt");
  const control = page.getByRole("button", { name: "Send now", exact: true });
  await control.focus(); await control.press("ArrowDown");
  await page.getByRole("radio", { name: "Queue", exact: true }).click();
  await page.getByRole("button", { name: "Add to queue" }).click();
  await page.getByRole("textbox").fill("Unsent ordinary draft");
  await hold(page, page.getByRole("button", { name: /Queued message 1:/ }));
  await page.getByRole("button", { name: "Edit prompt", exact: true }).click();
  await expect(page.getByRole("textbox")).toHaveValue("Original queued prompt");
  await page.getByRole("textbox").fill("Edited queued prompt");
  await page.getByRole("button", { name: "Save queued message" }).click();
  await expect(page.getByRole("textbox")).toHaveValue("Unsent ordinary draft");
  await expect(page.getByRole("button", { name: /Queued message 1: Edited queued prompt/ })).toBeVisible();
  expect(calls.find(c => c.action === "save").version).toBe(1);
  expect(calls.filter(c => c.mode)).toHaveLength(1);
});

test("movement cancels long press and does not send; context menu works without haptics", async ({ page }) => {
  const { calls } = await setup(page);
  await page.evaluate(() => Object.defineProperty(navigator, "vibrate", { value: undefined }));
  await page.getByRole("textbox").fill("Keep my draft");
  const control = page.getByRole("button", { name: "Send now", exact: true });
  await control.dispatchEvent("pointerdown", { pointerId: 1, isPrimary: true, button: 0, clientX: 20, clientY: 20 });
  await control.dispatchEvent("pointermove", { pointerId: 1, isPrimary: true, clientX: 20, clientY: 45 });
  await page.waitForTimeout(520);
  await control.dispatchEvent("pointerup", { pointerId: 1 });
  await control.dispatchEvent("click", { detail: 1 });
  expect(calls).toHaveLength(0);
  await expect(page.getByRole("radiogroup", { name: "Message delivery mode" })).toHaveCount(0);
  await control.click({ button: "right" });
  await expect(page.getByRole("radiogroup", { name: "Message delivery mode" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(control).toBeFocused();
  expect(calls).toHaveLength(0);
});

// Mouse hold does not reproduce a phone's compatibility mousedown after touchend.
async function touchHold(page: Page, button: Locator) {
  const box = (await button.boundingBox())!;
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
    await page.waitForTimeout(520);
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    // Allow focus-out dismissal and exit animation to run before checking stability.
    await page.waitForTimeout(200);
  } finally { await session.detach(); }
}

test("touch release keeps Send/Queue open for either selection without sending", async ({ page }) => {
  const { calls } = await setup(page);
  await page.getByRole("textbox").fill("Keep this mobile draft");
  const delivery = page.getByRole("radiogroup", { name: "Message delivery mode" });
  await touchHold(page, page.getByRole("button", { name: "Send now", exact: true }));
  await expect(delivery).toBeVisible();
  expect(calls).toHaveLength(0);
  await page.getByRole("radio", { name: "Queue", exact: true }).tap();
  await expect(delivery).toBeHidden();
  await touchHold(page, page.getByRole("button", { name: "Add to queue", exact: true }));
  await expect(delivery).toBeVisible();
  await page.getByRole("radio", { name: "Send now", exact: true }).tap();
  await expect(page.getByRole("textbox")).toHaveValue("Keep this mobile draft");
  expect(calls).toHaveLength(0);
  await touchHold(page, page.getByRole("button", { name: "Send now", exact: true }));
  await expect(delivery).toBeVisible();
  await page.touchscreen.tap(12, 100);
  await expect(delivery).toBeHidden();
  expect(calls).toHaveLength(0);
  await page.getByRole("button", { name: "Send now", exact: true }).tap();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0].mode).toBe("send");
});

test("touch release keeps queued-message actions open and editing preserves the ordinary draft", async ({ page }) => {
  const { calls } = await setup(page);
  await page.getByRole("textbox").fill("Queued from the phone");
  const control = page.getByRole("button", { name: "Send now", exact: true });
  await control.focus(); await control.press("ArrowDown");
  await page.getByRole("radio", { name: "Queue", exact: true }).tap();
  await page.getByRole("button", { name: "Add to queue" }).tap();
  await page.getByRole("textbox").fill("Ordinary mobile draft");
  await touchHold(page, page.getByRole("button", { name: /Queued message 1:/ }));
  const edit = page.getByRole("button", { name: "Edit prompt", exact: true });
  await expect(edit).toBeVisible();
  expect(calls.filter(call => call.mode)).toHaveLength(1);
  await edit.tap();
  await expect(page.getByRole("textbox")).toHaveValue("Queued from the phone");
  await page.getByRole("button", { name: "Cancel editing" }).tap();
  await expect(page.getByRole("textbox")).toHaveValue("Ordinary mobile draft");
});
