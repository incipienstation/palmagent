import { test, expect, type Locator, type Page } from "@playwright/test";
import { tasks } from "../fixtures.mjs";
import type { MessageQueue } from "@palmagent/shared";
import { installScopedStream, open, send } from "./_scoped-stream";

async function hold(page: Page, button: Locator) {
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.waitForTimeout(520); await page.mouse.up();
}
async function setup(page: Page, idle = false) {
  await installScopedStream(page);
  await page.addInitScript(() => {
    Object.assign(window, { vibrations: [] });
    Object.defineProperty(navigator, "vibrate", { configurable: true, value: (ms: number) => { (window as any).vibrations.push(ms); return true; } });
  });
  const state: MessageQueue = { revision: 1, paused: false, runId: "run-1", messages: [] };
  const calls: any[] = [];
  await page.route("**/api/tasks/t-run/messages**", async route => {
    const req = route.request().postDataJSON(); calls.push(req);
    if (req.mode === "queue") state.messages.push({ id: req.clientMessageId, version: 1, status: "queued", mode: "queue", text: req.text, images: req.images, settings: req.settings });
    if (req.action === "save") { state.messages[0].text = req.text; state.messages[0].version++; delete state.messages[0].editingUntil; }
    if (req.action === "edit" || req.action === "renew") state.messages[0].editingUntil = Date.now() + 60000;
    if (req.action === "release") delete state.messages[0].editingUntil;
    if (req.action === "delete" || req.action === "send") state.messages.shift();
    state.revision++;
    await route.fulfill({ json: state });
  });
  await open(page, "t-run");
  await send(page, "t-run", { type: "tasks", tasks: [{ ...tasks.find(t => t.taskId === "t-run")!, ...(idle ? { status: "idle" as const } : {}), messageQueue: state }], historyThrough: 0 });
  return { calls, state };
}

test("running and queued-edit summaries show the applicable settings without changing them", async ({ page }) => {
  const { calls, state } = await setup(page);
  const input = page.getByRole("textbox");
  const summary = page.getByRole("button", { name: "Current task settings" });
  const settings = page.getByRole("button", { name: "Configure task settings" });
  await expect(summary).toBeVisible();
  await expect(summary).toBeDisabled();
  await expect(summary).toContainText("sonnet");
  await input.fill("Use these settings later");
  const control = page.getByRole("button", { name: "Send now", exact: true });
  await control.focus(); await control.press("ArrowDown");
  await page.getByRole("radio", { name: "Queue", exact: true }).click();
  await settings.click();
  await page.getByRole("radio", { name: "opus", exact: true }).click();
  await page.getByRole("combobox", { name: "Effort", exact: true }).click();
  await page.getByRole("option", { name: "high", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await input.fill("Use these settings later");
  await page.getByRole("button", { name: "Add to queue" }).click();
  await expect.poll(() => calls.filter(call => call.mode === "queue").length).toBe(1);
  expect(calls.find(call => call.mode === "queue").settings).toMatchObject({ model: "opus", effort: "high" });
  // The next live message still uses the running turn, not the queue overrides.
  await expect(summary).toContainText("sonnet");
  await input.fill("Ordinary draft");
  await hold(page, page.getByRole("button", { name: /Queued message 1:/ }));
  await page.getByRole("button", { name: "Edit prompt", exact: true }).click();
  await expect(summary).toContainText("opus · high");
  await expect(summary).toBeDisabled();
  await page.getByRole("button", { name: "Cancel editing" }).click();
  await expect(input).toHaveValue("Ordinary draft");
  await expect(summary).toContainText("sonnet");
  // Empty persisted overrides explicitly reset to the agent's default; they
  // must not inherit the running model or produce a blank summary.
  state.messages[0].settings = { model: "", effort: "" };
  await hold(page, page.getByRole("button", { name: /Queued message 1:/ }));
  await page.getByRole("button", { name: "Edit prompt", exact: true }).click();
  await expect(summary).toContainText("Claude");
  await page.getByRole("button", { name: "Cancel editing" }).click();
  await expect(summary).toContainText("sonnet");
});

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
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  expect(calls[0].mode).toBe("queue");
  expect(await page.evaluate(() => (window as any).vibrations)).toEqual([12, 6]);
  await expect(page).toHaveScreenshot("message-queue.png");
});

for (const keyboard of [false, true]) test(`queue editing saves in place and restores the ordinary draft (${keyboard ? "keyboard" : "button"})`, async ({ page }) => {
  const { calls } = await setup(page);
  await page.getByRole("textbox").fill("Original queued prompt");
  const control = page.getByRole("button", { name: "Send now", exact: true });
  await control.focus(); await control.press("ArrowDown");
  await page.getByRole("radio", { name: "Queue", exact: true }).click();
  if (keyboard) await page.getByRole("textbox").press("Control+Enter");
  else await page.getByRole("button", { name: "Add to queue" }).click();
  await page.getByRole("textbox").fill("Unsent ordinary draft");
  await hold(page, page.getByRole("button", { name: /Queued message 1:/ }));
  await page.getByRole("button", { name: "Edit prompt", exact: true }).click();
  await expect(page.getByRole("textbox")).toHaveValue("Original queued prompt");
  await page.getByRole("textbox").fill("Edited queued prompt");
  if (keyboard) await page.getByRole("textbox").press("Meta+Enter");
  else await page.getByRole("button", { name: "Save queued message" }).click();
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

for (const focusDuringHold of [false, true]) {
  test(`collapsed composer hold ${focusDuringHold ? "survives input focus and keyboard reflow" : "keeps Send and Queue selectable"}`, async ({ page }) => {
    const { calls } = await setup(page, true);
    const input = page.getByRole("textbox");
    const composer = page.getByRole("group", { name: "Message composer", exact: true });
    const menu = page.getByRole("radiogroup", { name: "Message delivery mode" });
    await expect(composer).toHaveAttribute("data-expanded", "false");
    await expect(input).not.toBeFocused();
    const box = (await page.getByRole("button", { name: "Send now", exact: true }).boundingBox())!;
    const session = await page.context().newCDPSession(page);
    try {
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
      await expect(menu).toBeVisible();
      if (focusDuringHold) {
        // Model the reported phone sequence: input focus and software-keyboard
        // reflow after opening, without a new tap. Desktop Chromium has no IME.
        await input.focus();
        await page.setViewportSize({ width: 360, height: 430 });
        await page.waitForTimeout(300);
        await expect(menu).toBeVisible();
      }
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(300);
      await expect(menu).toBeVisible();
      if (!focusDuringHold) {
        await expect(input).not.toBeFocused();
        await expect(composer).toHaveAttribute("data-expanded", "false");
      }
      await page.getByRole("radio", { name: "Queue", exact: true }).tap();
      await expect(menu).toBeHidden();
      await touchHold(page, page.getByRole("button", { name: "Add to queue", exact: true }));
      await expect(menu).toBeVisible();
      await page.getByRole("radio", { name: "Send now", exact: true }).tap();
      await expect(menu).toBeHidden();
      expect(calls).toHaveLength(0);
      expect(await page.evaluate(() => (window as any).vibrations)).toEqual([12, 6, 12, 6]);
      // A new deliberate input tap still dismisses the menu and focuses input.
      await touchHold(page, page.getByRole("button", { name: "Send now", exact: true }));
      await expect(menu).toBeVisible();
      await input.tap({ position: { x: 8, y: 10 } });
      await expect(menu).toBeHidden();
      await expect(input).toBeFocused();
    } finally { await session.detach(); }
  });
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
  await expect(page.getByRole("textbox")).toBeFocused();
  expect(calls.filter(call => call.mode)).toHaveLength(1);
  await edit.tap();
  await expect(page.getByRole("textbox")).toHaveValue("Queued from the phone");
  await page.getByRole("button", { name: "Cancel editing" }).tap();
  await expect(page.getByRole("textbox")).toHaveValue("Ordinary mobile draft");
});

for (const draft of ["", "Keep the keyboard open"]) {
  test(`touch menu keeps input focus with ${draft ? "a draft" : "an empty composer"} and a keyboard-sized viewport`, async ({ page }) => {
    const { calls } = await setup(page, !draft);
    await page.setViewportSize({ width: 360, height: 430 });
    const input = page.getByRole("textbox");
    await input.fill(draft);
    // Desktop Chromium has no software keyboard. Model its blur -> viewport
    // expansion: staging retargeted the release's mousedown outside the anchor.
    await page.exposeFunction("dismissTestKeyboard", () => page.setViewportSize({ width: 360, height: 780 }));
    await input.evaluate(el => el.addEventListener("blur", () => { void (window as any).dismissTestKeyboard(); }, { once: true }));
    await input.focus();
    await touchHold(page, page.getByRole("button", { name: "Send now", exact: true }));
    await expect(page.getByRole("radiogroup", { name: "Message delivery mode" })).toBeVisible();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(draft);
    expect(calls).toHaveLength(0);
    await page.getByRole("radio", { name: "Queue", exact: true }).tap();
    const queue = page.getByRole("button", { name: "Add to queue" });
    await expect(queue).toBeVisible();
    // Switching from touch to keyboard must still move focus into the options.
    await expect(page.getByRole("radiogroup", { name: "Message delivery mode" })).toBeHidden();
    await queue.focus();
    await queue.press("ArrowDown");
    await expect(page.getByRole("radio", { name: "Queue", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    expect(calls).toHaveLength(0);
  });
}

test("finishing the mode menu exit does not steal focus from a resumed draft", async ({ page }) => {
  const { calls } = await setup(page, true);
  const control = page.getByRole("button", { name: "Send now", exact: true });
  await control.focus();
  await control.press("ArrowDown");
  await page.getByRole("radio", { name: "Queue", exact: true }).tap();
  const input = page.getByRole("textbox");
  await input.fill("Continue typing while the menu closes");
  await page.waitForTimeout(300);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Continue typing while the menu closes");
  expect(calls).toHaveLength(0);
});

for (const ancestor of [false, true]) {
  test(`scrolling ${ancestor ? "an ancestor cancels" : "a sibling preserves"} a composer long press`, async ({ page }) => {
    const { calls } = await setup(page);
    await page.getByRole("textbox").fill("Preserve this draft during scrolling");
    const control = page.getByRole("button", { name: "Send now", exact: true });
    const box = (await control.boundingBox())!;
    const session = await page.context().newCDPSession(page);
    try {
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
      await page.waitForTimeout(150);
      // Dispatch on the real containing shell or a separate transcript panel:
      // only scrolling that can move the held button should cancel its timer.
      await control.evaluate((element, ancestor) => {
        const target = ancestor ? element.parentElement! : document.querySelector('[data-virtuoso-scroller]')!;
        target.dispatchEvent(new Event("scroll"));
      }, ancestor);
      await page.waitForTimeout(400);
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(250);
      const menu = page.getByRole("radiogroup", { name: "Message delivery mode" });
      if (ancestor) await expect(menu).toBeHidden();
      else await expect(menu).toBeVisible();
      expect(calls).toHaveLength(0);
      await expect(page.getByRole("textbox")).toHaveValue("Preserve this draft during scrolling");
    } finally { await session.detach(); }
  });
}
