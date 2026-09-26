import { test, expect, type Page } from "@playwright/test";
import { tasks } from "../fixtures.mjs";
import { assertViewportLocked, openSessionDetails } from "./_helpers";

test.use({ serviceWorkers: "block" });

const toastSelector = '[data-testid="toast"][data-front="true"][data-removed="false"]';
const currentToast = (page: Page) => page.locator(toastSelector);

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
  }).toBeGreaterThanOrEqual(0);
  const send = page.getByRole("button", { name: /^(Dispatch|Send now)$/ });
  // Draft growth and keyboard resize commit asynchronously. Require reachability
  // while feedback is still visible, so automatic dismissal cannot satisfy it.
  await expect.poll(() => send.evaluate((el, selector) => {
    const toast = document.querySelector(selector);
    const r = el.getBoundingClientRect();
    return Boolean(toast?.getClientRects().length)
      && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  }, toastSelector)).toBe(true);
}

test("dispatch feedback leaves the composer reachable and dismisses automatically", async ({ page }) => {
  await page.route("**/api/tasks", route => route.request().method() === "POST"
    ? route.fulfill({ json: { task: tasks.find(t => t.taskId === "t-idle-rich") } }) : route.continue());
  await page.goto("/#/new");
  await page.getByLabel("Prompt", { exact: true }).fill("Review the changes.");
  await page.getByRole("button", { name: "Dispatch", exact: true }).tap();
  await expect(currentToast(page)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await assertClearOfComposer(page);
  await expect(currentToast(page)).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId("toast")).toHaveCount(0, { timeout: 4000 });
});

test("errors wrap without covering input, including both keyboard resize models", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await dispatchError(page, "The connection was interrupted. Your draft is still here; try sending it again when connected.");
  await assertClearOfComposer(page);
  const toast = currentToast(page);
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
});

test("repeated errors replace the old toast and leave Send reachable", async ({ page }) => {
  await dispatchError(page);
  await page.getByRole("button", { name: "Dispatch", exact: true }).tap();
  await expect(page.locator('[data-testid="toast"][data-removed="false"]')).toHaveCount(1);
  await expect(page.getByTestId("toast")).toHaveCount(1);
  await assertClearOfComposer(page);
});

test("toast dismisses after a downward touch swipe", async ({ page, context }) => {
  await dispatchError(page);
  await assertClearOfComposer(page);
  const toast = currentToast(page);
  await toast.click({ trial: true });
  const box = (await toast.boundingBox())!;
  const cdp = await context.newCDPSession(page);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  for (const dy of [5, 10, 20, 30]) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, y: point.y + dy }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, y: point.y + 65 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  // A swipe must dismiss promptly, before the error toast's automatic expiry.
  await expect(page.getByTestId("toast")).toHaveCount(0, { timeout: 1500 });
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
  await expect(currentToast(page)).toBeVisible();
  await expect.poll(async () => {
    const toast = (await currentToast(page).boundingBox())!;
    const button = (await page.getByRole("button", { name: "Dispatch new task" }).boundingBox())!;
    return button.y - toast.y - toast.height;
  }).toBeGreaterThanOrEqual(0);
});

test("desktop toast keeps unbroken error text within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await dispatchError(page, "Unavailable_".repeat(20));
  await assertClearOfComposer(page);
  await expect(currentToast(page)).toBeInViewport({ ratio: 1 });
  await assertViewportLocked(page);
});

test("copy feedback does not dismiss its parent sheet", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async () => {} },
  }));
  await page.route("**/api/tasks/t-idle-rich/handoff", route => route.fulfill({
    json: { command: "palmagent resume example-session" },
  }));
  await page.goto("/#/task/t-idle-rich");
  await openSessionDetails(page);
  await page.getByRole("button", { name: "Release to shell" }).click();
  await page.getByRole("button", { name: "Copy resume command" }).click();
  await expect(currentToast(page)).toBeVisible();
  await currentToast(page).tap();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy resume command" })).toBeVisible();
});
