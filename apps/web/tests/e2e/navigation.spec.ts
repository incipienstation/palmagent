import { test, expect } from "@playwright/test";
import { assertViewportLocked, captureForReview } from "./_helpers";

test("drawer routes share the inbox stream and retain the new-task draft", async ({ page }) => {
  let streams = 0;
  page.on("request", request => { if (new URL(request.url()).searchParams.get("snapshots") === "1") streams++; });
  await page.goto("/");
  await expect(page.getByText("Wire the web QA harness", { exact: true })).toBeVisible();
  const menu = page.getByRole("button", { name: "Open navigation" });
  await menu.click();
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await expect(navigation.getByRole("button", { name: "Tasks", exact: true })).toHaveAttribute("aria-current", "page");
  await navigation.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await menu.click();
  await navigation.getByRole("button", { name: "Routines", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Routines", exact: true })).toBeVisible();
  await menu.click();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("Keep this mobile draft");
  await menu.click();
  await page.getByRole("button", { name: "Wire the web QA harness", exact: true }).click();
  await expect(page).toHaveURL(/#\/task\/t-idle-rich$/);
  await menu.click();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("Keep this mobile draft");
  expect(streams).toBe(1);
});

test("drawer closes with Escape and scrim, restores focus, and opens Spaces on a narrow phone", async ({ page }) => {
  const width = 320;
  await page.setViewportSize({ width, height: 780 });
  await page.goto("/?__theme=light");
  const menu = page.getByRole("button", { name: "Open navigation" });
  await menu.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await assertViewportLocked(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(menu).toBeFocused();
  await menu.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.mouse.click(width - 5, 180);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(menu).toBeFocused();
  await menu.click();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Spaces", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Spaces", exact: true, level: 1 })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search Spaces" }).fill("palmagent");
  await assertViewportLocked(page);
  await menu.click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Appearance", exact: true })).toBeVisible();
  await assertViewportLocked(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(menu).toBeFocused();
});

test("drawer actions remain reachable in a short landscape viewport", async ({ page }) => {
  const height = 320;
  await page.setViewportSize({ width: 640, height });
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation" }).click();
  const dialog = page.getByRole("dialog");
  for (const name of ["Close navigation", "New task", "Settings"]) {
    const button = dialog.getByRole("button", { name, exact: true });
    const bounds = (await button.boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
  }
  const viewport = dialog.locator('[data-radix-scroll-area-viewport]');
  await viewport.evaluate(el => { el.scrollTop = el.scrollHeight; });
  expect(await viewport.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await expect(dialog.getByRole("button", { name: "Settings", exact: true })).toBeInViewport({ ratio: 1 });
  await assertViewportLocked(page);
});


test.describe("desktop navigation", () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

  test("docked conversation stays interactive and collapse survives routes and reload", async ({ page }) => {
    let streams = 0;
    page.on("request", request => { if (new URL(request.url()).searchParams.get("snapshots") === "1") streams++; });
    await page.goto("/#/task/t-idle-rich");
    const sidebar = page.getByRole("complementary", { name: "Space navigation" });
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(sidebar).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await message.fill("Keep this desktop draft");
    const original = await message.elementHandle();
    const bounds = (await message.boundingBox())!;
    const rail = (await sidebar.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(rail.x + rail.width);
    expect(bounds.width).toBeLessThanOrEqual(720);
    const actions = (await page.getByRole("button", { name: "Task actions", exact: true }).boundingBox())!;
    expect(actions.x).toBeGreaterThan(bounds.x + bounds.width / 2);
    await captureForReview(page, "desktop-navigation-open.png");
    await sidebar.getByRole("button", { name: "Collapse navigation" }).click();
    const menu = page.getByRole("button", { name: "Open navigation" });
    await expect(menu).toBeFocused();
    await expect(sidebar).toHaveCount(0);
    await menu.press("Enter");
    await expect(sidebar.getByRole("button", { name: "Collapse navigation" })).toBeFocused();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await message.evaluate((el, old) => el === old, original)).toBe(true);
    await expect(message).toHaveValue("Keep this desktop draft");
    await sidebar.getByRole("button", { name: "Agents", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
    await expect(sidebar).toBeVisible();
    await sidebar.getByRole("button", { name: "Wire the web QA harness", exact: true }).click();
    await expect(message).toHaveValue("Keep this desktop draft");
    expect(streams).toBe(1);
    await sidebar.getByRole("button", { name: "Collapse navigation" }).click();
    await page.reload();
    await expect(menu).toBeVisible();
    await expect(sidebar).toHaveCount(0);
    await menu.click();
    await page.reload();
    await expect(sidebar).toBeVisible();
    await assertViewportLocked(page);
    await page.setViewportSize({ width: 1024, height: 320 });
    for (const name of ["Collapse navigation", "New task", "Settings"]) {
      await expect(sidebar.getByRole("button", { name, exact: true })).toBeInViewport({ ratio: 1 });
    }
    await assertViewportLocked(page);
  });

  test("resizing dismisses the mobile modal and retains the desktop preference and input", async ({ page }) => {
    await page.goto("/#/task/t-idle-rich");
    const sidebar = page.getByRole("complementary", { name: "Space navigation" });
    const menu = page.getByRole("button", { name: "Open navigation" });
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await message.fill("Keep draft while resizing");
    const original = await message.elementHandle();
    await sidebar.getByRole("button", { name: "Collapse navigation" }).click();
    await page.setViewportSize({ width: 767, height: 900 });
    await menu.click();
    await expect(page.getByRole("dialog", { name: "Palmagent", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 768, height: 900 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(sidebar).toHaveCount(0);
    await expect(menu).toBeFocused();
    await message.fill("Still editable after resize");
    await menu.click();
    await expect(sidebar).toBeVisible();
    await assertViewportLocked(page);
    await page.setViewportSize({ width: 360, height: 780 });
    await expect(menu).toBeFocused();
    await menu.click();
    await captureForReview(page, "mobile-navigation-overlay.png");
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(sidebar.getByRole("button", { name: "Collapse navigation" })).toBeFocused();
    await expect(message).toHaveValue("Still editable after resize");
    expect(await message.evaluate((el, old) => el === old, original)).toBe(true);
    await message.focus();
    await page.keyboard.type("!");
    await expect(message).toHaveValue("Still editable after resize!");
    await page.setViewportSize({ width: 360, height: 780 });
    await expect(message).toBeFocused();
    // The viewport bridge updates its height on the next animation frame.
    await expect(page.locator("html")).toHaveCSS("--app-height", "780px");
    await assertViewportLocked(page);
    await menu.click();
    await page.getByRole("dialog", { name: "Palmagent", exact: true }).getByRole("button", { name: "Settings", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(settings).toBeVisible();
    await settings.getByRole("button", { name: "Close settings" }).click();
    await expect(settings).toHaveCount(0);
    await expect(sidebar.getByRole("button", { name: "Collapse navigation" })).toBeFocused();
  });
});
