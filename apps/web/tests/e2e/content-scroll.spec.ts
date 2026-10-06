import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { assertViewportLocked } from "./_helpers";
import { installScopedStream, open, send } from "./_scoped-stream";

test.use({ serviceWorkers: "block" });

async function reply(page: Page, text: string) {
  await installScopedStream(page);
  const taskId = "t-idle-rich";
  await open(page, taskId);
  await send(page, taskId, { type: "tasks", tasks: [], historyThrough: 0 });
  await send(page, taskId, { type: "event", event: {
    taskId, agent: "codex", ts: 1, kind: "assistant_text", payload: { text, messageId: "scroll-reply" },
  } }, 1);
}

for (const kind of ["Code", "Table"] as const) {
  test(`${kind} scrolls horizontally without capturing transcript wheel scrolling`, async ({ page, context }) => {
    const wide = "long_column_value_".repeat(10);
    const content = kind === "Code" ? `\`\`\`text\n${wide}\n\`\`\`` : `| First | Second |\n| --- | --- |\n| ${wide} | ${wide} |`;
    await reply(page, Array.from({ length: 12 }, (_, i) => `Paragraph ${i}`).join("\n\n") + "\n\n" + content);
    const rail = page.locator(`[data-slot="scroll-area-viewport"][aria-label="${kind}"]`);
    await expect(rail).toBeVisible();
    await rail.scrollIntoViewIfNeeded();
    await expect.poll(() => rail.evaluate(el => el.scrollWidth - el.clientWidth)).toBeGreaterThan(100);
    await rail.hover();
    await page.mouse.wheel(250, 0);
    await expect.poll(() => rail.evaluate(el => el.scrollLeft)).toBeGreaterThan(50);
    const area = rail.locator("..");
    await expect(area.locator('[data-orientation="horizontal"][data-slot="scroll-area-scrollbar"]')).toBeVisible();
    const scroller = page.locator('[data-radix-scroll-area-viewport][aria-label="Session transcript"]');
    const before = await scroller.evaluate(el => el.scrollTop);
    await page.mouse.wheel(0, -140);
    await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBeLessThan(before - 20);
    await rail.scrollIntoViewIfNeeded();
    await rail.evaluate(el => { el.scrollLeft = 0; });
    const box = (await rail.boundingBox())!;
    const x = box.x + box.width * 0.8, y = box.y + box.height / 2;
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 0 }] });
    for (let delta = 20; delta <= 140; delta += 20) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - delta, y, id: 0 }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => rail.evaluate(el => el.scrollLeft)).toBeGreaterThan(40);
    await cdp.detach();
    await assertViewportLocked(page);
  });
}

test("actual-size image scrolls on both axes while Fit stays reachable on a short screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 360 });
  const png = readFileSync(new URL("../../public/icon-512.png", import.meta.url));
  await page.route("**/api/tasks/*/image?*", route => route.fulfill({ contentType: "image/png", body: png }));
  await reply(page, "![Preview](preview.png)");
  await page.getByRole("button", { name: "Enlarge image: Preview" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Actual size" }).click();
  const area = dialog.locator('[data-slot="scroll-area-viewport"]');
  await expect.poll(() => area.evaluate(el => Math.min(el.scrollWidth - el.clientWidth, el.scrollHeight - el.clientHeight))).toBeGreaterThan(100);
  await area.evaluate(el => el.scrollTo({ left: el.scrollWidth, top: el.scrollHeight }));
  await expect.poll(() => area.evaluate(el => Math.min(el.scrollLeft, el.scrollTop))).toBeGreaterThan(100);
  await expect(dialog.getByRole("button", { name: "Fit image" })).toBeInViewport({ ratio: 1 });
  await dialog.getByRole("button", { name: "Fit image" }).click();
  await expect.poll(() => area.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await assertViewportLocked(page);
});

test("short-screen action menu scrolls to its last item with the keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 280 });
  await page.goto("/#/task/t-idle-rich");
  const trigger = page.getByRole("button", { name: "Task actions" });
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const area = menu.locator('[data-slot="scroll-area-viewport"]');
  await expect.poll(() => area.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
  await page.keyboard.press("End");
  const last = menu.getByRole("menuitem").last();
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport({ ratio: 1 });
  await expect.poll(() => area.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press("Home");
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await expect.poll(() => area.evaluate(el => el.scrollTop)).toBe(0);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await assertViewportLocked(page);
});
