import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { installScopedStream, open, send } from "./_scoped-stream";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });

async function swipeRight(page: Page, x: number, y: number) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let step = 1; step <= 8; step++) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 15 * step, y }] });
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally { await session.detach(); }
}

for (const kind of ["diagram", "image"] as const) {
  test(`fullscreen ${kind} swipes pan without opening navigation, including the header`, async ({ page }) => {
    const label = kind === "diagram" ? "Mermaid diagram" : "Preview";
    const text = kind === "diagram"
      ? "```mermaid\nflowchart LR\n  A[Start] --> B[Finish]\n```"
      : "![Preview](preview.png)";
    const png = readFileSync(new URL("../../public/icon-512.png", import.meta.url));
    await page.route("**/api/tasks/*/image?*", route => route.fulfill({ contentType: "image/png", body: png }));
    await installScopedStream(page);
    const taskId = "t-idle-rich";
    await open(page, taskId);
    await send(page, taskId, { type: "tasks", tasks: [], historyThrough: 0 });
    await send(page, taskId, { type: "event", event: {
      taskId, agent: "codex", ts: 1, kind: "assistant_text", payload: { text, messageId: "fullscreen-swipe" },
    } }, 1);
    const trigger = page.getByRole("button", { name: kind === "diagram" ? "Open diagram fullscreen" : "Enlarge image: Preview" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: label, exact: true });
    await expect(dialog).toBeVisible();
    await dialog.evaluate(async element => {
      await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
    });
    await dialog.getByRole("button", { name: `Zoom in ${kind}` }).click();
    const image = dialog.getByRole("img", { name: label, exact: true });
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    const before = await image.evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element.parentElement!).transform).m41);
    const canvas = (await dialog.getByRole("region", { name: label, exact: true }).boundingBox())!;
    await swipeRight(page, canvas.x + 100, canvas.y + canvas.height / 2);
    await expect(page.getByRole("button", { name: "Close navigation" })).toHaveCount(0);
    await expect.poll(() => image.evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element.parentElement!).transform).m41)).toBeGreaterThan(before);
    await swipeRight(page, 8, canvas.y + canvas.height / 2);
    await expect(page.locator('[data-side="left"][data-slot="drawer-content"]')).toHaveCount(0);
    const header = (await dialog.getByRole("heading", { name: label, exact: true }).boundingBox())!;
    await swipeRight(page, header.x + 10, header.y + header.height / 2);
    await expect(page.getByRole("button", { name: "Close navigation" })).toHaveCount(0);
    await dialog.getByRole("button", { name: `Exit ${kind} fullscreen` }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await swipeRight(page, 8, 400);
    await expect(page.getByRole("button", { name: "Close navigation" })).toBeVisible();
  });
}
