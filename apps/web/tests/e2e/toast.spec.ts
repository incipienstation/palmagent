import { test, expect, type Page } from "@playwright/test";
import { tasks } from "../fixtures.mjs";
import { assertViewportLocked } from "./_helpers";

test.use({ serviceWorkers: "block" });

const currentToast = (page: Page) => page.locator('[data-testid="toast"][data-front="true"][data-removed="false"]');

async function dispatchError(page: Page, message = "Please try again.") {
  await page.route("**/api/tasks", route => route.request().method() === "POST"
    ? route.fulfill({ status: 503, json: { error: message } }) : route.continue());
  await page.goto("/#/new");
  await page.getByLabel("Prompt", { exact: true }).fill("Review the changes.");
  await page.getByRole("button", { name: "Dispatch", exact: true }).tap();
  await expect(currentToast(page)).toContainText(message);
}

async function assertClearOfComposer(page: Page) {
  await expect.poll(async () => {
    const toast = await currentToast(page).boundingBox();
    const composer = await page.getByRole("group", { name: "Message composer", exact: true }).boundingBox();
    return composer!.y - toast!.y - toast!.height;
  }).toBeGreaterThanOrEqual(23);
  const send = page.getByRole("button", { name: /^(Dispatch|Send now)$/ });
  expect(await send.evaluate(el => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  })).toBe(true);
}

for (const theme of ["dark", "light"]) test(`short ${theme} toast fits its text above the composer`, async ({ page }) => {
  await page.route("**/api/tasks", route => route.request().method() === "POST"
    ? route.fulfill({ json: { task: tasks.find(t => t.taskId === "t-idle-rich") } }) : route.continue());
  await page.goto(`/?__theme=${theme}#/new`);
  await page.getByLabel("Prompt", { exact: true }).fill("Review the changes.");
  await page.getByRole("button", { name: "Dispatch", exact: true }).tap();
  await expect(currentToast(page)).toHaveText("Dispatched");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await assertClearOfComposer(page);
  const box = (await currentToast(page).boundingBox())!;
  expect(box.width).toBeLessThan(160);
  expect(box.height).toBeLessThanOrEqual(48);
  expect(box.x + box.width / 2).toBeCloseTo(180, 0);
  await expect(currentToast(page).locator('svg, button')).toHaveCount(0);
  // Snapshot the transient component itself; its position relative to the live
  // conversation is checked above without coupling this to transcript rendering.
  await expect(currentToast(page)).toHaveAttribute("data-mounted", "true");
  const screenshotStyle = await page.addStyleTag({ content: "#root { visibility: hidden; }" });
  await expect(currentToast(page)).toHaveScreenshot(`compact-toast-${theme}.png`);
  await screenshotStyle.evaluate(element => element.remove());
  await expect(page.getByTestId("toast")).toHaveCount(0, { timeout: 4000 });
});

test("errors wrap without covering input, including both keyboard resize models", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await dispatchError(page, "The connection was interrupted. Your draft is still here; try sending it again when connected.");
  await assertClearOfComposer(page);
  const toast = currentToast(page);
  const box = (await toast.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(288);
  expect(box.x).toBeGreaterThanOrEqual(16);
  await expect(toast).toBeInViewport({ ratio: 1 });
  await page.getByLabel("Prompt", { exact: true }).fill("A taller draft\n".repeat(6));
  await assertClearOfComposer(page);
  // Android resizes the layout viewport; Safari can resize only the visual one.
  await page.setViewportSize({ width: 320, height: 480 });
  await assertClearOfComposer(page);
  await expect(toast).toBeInViewport({ ratio: 1 });
  await page.setViewportSize({ width: 320, height: 780 });
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, "height", { configurable: true, value: 480 });
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  await assertClearOfComposer(page);
  expect((await toast.boundingBox())!.y).toBeGreaterThanOrEqual(0);
  await assertViewportLocked(page);
  await expect(page).toHaveScreenshot("compact-toast-error-keyboard.png");
});

test("repeated errors replace the old toast and leave Send reachable", async ({ page }) => {
  await dispatchError(page);
  await page.getByRole("button", { name: "Dispatch", exact: true }).tap();
  await expect(page.locator('[data-testid="toast"][data-removed="false"]')).toHaveCount(1);
  await expect(page.getByTestId("toast")).toHaveCount(1);
  await assertClearOfComposer(page);
});

test("toast follows a downward touch swipe and dismisses", async ({ page, context }) => {
  await dispatchError(page);
  await assertClearOfComposer(page);
  const toast = currentToast(page);
  await expect(toast).toHaveAttribute("data-mounted", "true");
  const box = (await toast.boundingBox())!;
  const cdp = await context.newCDPSession(page);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  for (const dy of [5, 10, 20, 30]) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, y: point.y + dy }] });
  }
  expect((await toast.boundingBox())!.y - box.y).toBeGreaterThan(15);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, y: point.y + 65 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(page.getByTestId("toast")).toHaveCount(0);
});

test("reduced motion keeps the toast readable and allows keyboard dismissal", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await dispatchError(page);
  await currentToast(page).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("toast")).toHaveCount(0);
});

test("root exit hint stays above the new-task button and respects safe areas", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "standalone", { value: true }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--safe-bottom", "34px");
    window.dispatchEvent(new Event("resize"));
    history.back();
  });
  await expect(currentToast(page)).toHaveText("Press back again to exit");
  await expect.poll(async () => {
    const toast = (await currentToast(page).boundingBox())!;
    const button = (await page.getByRole("button", { name: "Dispatch new task" }).boundingBox())!;
    return button.y - toast.y - toast.height;
  }).toBeGreaterThanOrEqual(23);
});

test("desktop toast remains centered and bounds unbroken error text", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await dispatchError(page, "Unavailable_".repeat(20));
  await assertClearOfComposer(page);
  const box = (await currentToast(page).boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(400);
  expect(box.x + box.width / 2).toBeCloseTo(640, 0);
  await assertViewportLocked(page);
});

test("copy feedback stays compact and does not dismiss its parent sheet", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async () => {} },
  }));
  await page.route("**/api/tasks/t-idle-rich/handoff", route => route.fulfill({
    json: { command: "palmagent resume example-session" },
  }));
  await page.goto("/#/task/t-idle-rich");
  await page.getByTitle("Session details", { exact: true }).click();
  await page.getByRole("button", { name: "Release to shell" }).click();
  await page.getByRole("button", { name: "Copy resume command" }).click();
  await expect(currentToast(page)).toHaveText("Copied.");
  expect((await currentToast(page).boundingBox())!.width).toBeLessThan(120);
  await currentToast(page).tap();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy resume command" })).toBeVisible();
});
