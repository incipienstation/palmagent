import { test, expect, type Page } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";

// These flows start with a previously used Space; first-use selection is covered in spaces.spec.ts.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pref:dispatch-repo", "repo-app"));
});

test.use({ serviceWorkers: "block" });

const toastSelector = '[data-testid="toast"][data-front="true"][data-removed="false"]';
const currentToast = (page: Page) => page.locator(toastSelector);

async function sendError(page: Page, message = "Please try again.") {
  await page.route("**/api/tasks/t-idle-rich/messages", route => route.fulfill({ status: 503, json: { error: message } }));
  await page.goto("/#/task/t-idle-rich");
  await page.getByLabel("Message", { exact: true }).fill("Review the changes.");
  await page.getByRole("button", { name: "Send now", exact: true }).tap();
  await expect(currentToast(page)).toContainText(message);
}

async function assertClearOfComposer(page: Page) {
  await expect.poll(async () => {
    const toast = await currentToast(page).boundingBox();
    const composer = await page.getByRole("group", { name: "Message composer", exact: true }).boundingBox();
    return composer!.y - toast!.y - toast!.height;
  }).toBeGreaterThanOrEqual(0);
  const send = page.getByRole("button", { name: /^Send now$/ });
  // Draft growth and keyboard resize commit asynchronously. Require reachability
  // while feedback is still visible, so automatic dismissal cannot satisfy it.
  await expect.poll(() => send.evaluate((el, selector) => {
    const toast = document.querySelector(selector);
    const r = el.getBoundingClientRect();
    return Boolean(toast?.getClientRects().length)
      && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  }, toastSelector)).toBe(true);
}

test("errors wrap without covering input, including both keyboard resize models", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await sendError(page, "The connection was interrupted. Your draft is still here; try sending it again when connected.");
  await assertClearOfComposer(page);
  const toast = currentToast(page);
  await expect(toast).toBeInViewport({ ratio: 1 });
  await page.getByLabel("Message", { exact: true }).fill("A taller draft\n".repeat(6));
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

test("toast dismisses after a downward touch swipe", async ({ page, context }) => {
  await sendError(page);
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
