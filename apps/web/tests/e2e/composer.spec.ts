import { test, expect, type Locator } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

async function onScreen(control: Locator) {
  await expect(control).toBeInViewport({ ratio: 1 });
  expect(await control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  }), "control is hittable").toBe(true);
}

for (const width of [360, 390]) test(`mobile composer states at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 780 });
  await page.goto("/#/new");
  const composer = page.getByRole("group", { name: "Message composer", exact: true });
  const prompt = page.getByLabel("Prompt", { exact: true });
  await expect(composer).toHaveAttribute("data-expanded", "false");
  await onScreen(prompt);
  expect((await composer.boundingBox())!.height).toBeLessThanOrEqual(60);
  await expect(page.getByRole("button", { name: "Dispatch", exact: true })).toBeDisabled();
  await prompt.tap();
  await expect(composer).toHaveAttribute("data-expanded", "true");
  await expect(prompt).toBeFocused();
  await onScreen(page.getByRole("button", { name: "Configure model and effort" }));
  if (width === 360) await expect(page).toHaveScreenshot("composer-focused.png");
  await page.getByRole("heading", { name: "Dispatch", exact: true }).tap();
  await expect(composer).toHaveAttribute("data-expanded", "false");

  // A reduced viewport represents the space left by a software keyboard.
  await page.setViewportSize({ width, height: 480 });
  await prompt.tap();
  await onScreen(prompt);
  await page.getByRole("button", { name: "Add attachments" }).tap();
  await onScreen(page.getByRole("menuitem", { name: "Camera" }));
  await onScreen(page.getByRole("menuitem", { name: "Photos" }));
  if (width === 360) await expect(page).toHaveScreenshot("composer-attachments.png");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Configure model and effort" }).tap();
  await onScreen(page.getByRole("button", { name: "Done", exact: true }));
  await expect(page.getByRole("dialog")).toBeInViewport({ ratio: 1 });
  if (width === 360) await expect(page).toHaveScreenshot("composer-configure-keyboard.png");
  await page.getByRole("button", { name: "Done", exact: true }).tap();
  await prompt.fill("Keep this draft\n".repeat(20));
  await page.getByRole("heading", { name: "Dispatch", exact: true }).tap();
  await expect(composer).toHaveAttribute("data-expanded", "true");
  expect((await prompt.boundingBox())!.height).toBeLessThanOrEqual(144);
  await onScreen(page.getByRole("button", { name: "Dispatch", exact: true }));
  await assertViewportLocked(page);
});

test("visual viewport keyboard resize keeps the composer visible without reflowing pinch zoom", async ({ page }) => {
  await page.goto("/#/task/t-idle-rich");
  await page.getByRole("textbox", { name: "Message", exact: true }).tap();
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, "height", { configurable: true, value: 480 });
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  await expect.poll(() => page.getByRole("group", { name: "Message composer", exact: true }).boundingBox().then((r) => r!.y + r!.height)).toBeLessThanOrEqual(480);
  expect((await page.getByLabel("Session transcript").boundingBox())!.height).toBeGreaterThan(100);
  await page.getByRole("button", { name: "Configure model and effort" }).tap();
  await expect.poll(() => page.getByRole("dialog").boundingBox().then((r) => r!.y + r!.height)).toBeLessThanOrEqual(480);
  await page.getByRole("button", { name: "Done", exact: true }).tap();
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, "scale", { configurable: true, value: 2 });
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--app-height"))).toBe("780px");
});

test("light mobile and desktop composers keep controls visible", async ({ page }) => {
  await page.goto("/?__theme=light#/new");
  await page.getByLabel("Prompt").fill("Review the changes");
  await onScreen(page.getByRole("button", { name: "Dispatch", exact: true }));
  await expect(page).toHaveScreenshot("composer-light.png");
  await page.setViewportSize({ width: 1280, height: 800 });
  await assertViewportLocked(page);
  await onScreen(page.getByRole("button", { name: "Configure model and effort" }));
  await expect(page).toHaveScreenshot("composer-desktop.png");
});

test("configuration choices survive reload without losing the prompt", async ({ page }) => {
  await page.goto("/#/new");
  await page.getByLabel("Prompt").fill("Review safely");
  await page.getByRole("button", { name: "Configure model and effort" }).click();
  await page.getByRole("radio", { name: "opus", exact: true }).click();
  await page.getByRole("combobox", { name: "Effort", exact: true }).click();
  await page.getByRole("option", { name: "high", exact: true }).click();
  await page.getByPlaceholder("short label").fill("Review");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  await expect(page.getByLabel("Prompt")).toHaveValue("Review safely");
  await expect(page.getByRole("button", { name: "Configure model and effort" })).toContainText("opus · high");
  await page.getByRole("button", { name: "Configure model and effort" }).click();
  await expect(page.getByPlaceholder("short label")).toHaveValue("Review");
  await expect(page.getByRole("radio", { name: "opus", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page).toHaveScreenshot("composer-configure.png");
});

for (const route of ["new", "task/t-idle-rich"]) test(`image-only submission and failed-send draft retention: ${route}`, async ({ page }) => {
  await page.goto(`/#/${route}`);
  const action = page.getByRole("button", { name: route === "new" ? "Dispatch" : "Send now", exact: true });
  const fileChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add attachments" }).click();
  await page.getByRole("menuitem", { name: "Photos" }).click();
  await (await fileChooser).setFiles({ name: "screenshot.png", mimeType: "image/png", buffer: png });
  await expect(page.getByAltText("attachment 1")).toBeVisible();
  await expect(action).toBeEnabled();
  const path = route === "new" ? "/api/tasks" : "/api/tasks/t-idle-rich/messages";
  await page.route(`**${path}`, (r) => r.fulfill({ status: 503, json: { error: "Try again" } }));
  const request = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === path);
  await action.click();
  const payload = (await request).postDataJSON();
  expect(payload.images).toHaveLength(1);
  await expect(action).toBeEnabled();
  await expect(page.getByAltText("attachment 1")).toBeVisible();
  await page.getByRole("button", { name: "Remove image 1" }).click();
  await expect(action).toBeDisabled();
});

test("follow-up settings submit only changed overrides and allow resetting to default", async ({ page }) => {
  await page.goto("/#/task/t-idle-rich");
  await page.route("**/api/tasks/t-idle-rich/messages", (r) => r.fulfill({ json: { revision: 1, paused: false, runId: null, messages: [] } }));
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Continue");
  await page.getByRole("button", { name: "Configure model and effort" }).click();
  await page.getByRole("radio", { name: /Default/ }).click();
  await page.getByRole("combobox", { name: "Effort", exact: true }).click();
  await page.getByRole("option", { name: "high", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const request = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/messages"));
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  expect((await request).postDataJSON()).toMatchObject({ mode: "send", text: "Continue", settings: { model: "" } });
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeEmpty();
});

test("Enter and IME composition keep writing without submitting", async ({ page }) => {
  await page.goto("/#/new");
  let sends = 0;
  page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/tasks")) sends++; });
  const prompt = page.getByLabel("Prompt");
  await prompt.fill("한글");
  await prompt.dispatchEvent("compositionstart");
  await prompt.press("Enter");
  await prompt.dispatchEvent("compositionend", { data: "한글" });
  await expect(prompt).toHaveValue("한글\n");
  expect(sends).toBe(0);
});
