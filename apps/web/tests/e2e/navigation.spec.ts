import { test, expect } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";

test("drawer routes share the inbox stream and retain the new-task draft", async ({ page }) => {
  let streams = 0;
  page.on("request", request => { if (new URL(request.url()).searchParams.get("snapshots") === "1") streams++; });
  await page.goto("/");
  await expect(page.getByText("Wire the web QA harness", { exact: true })).toBeVisible();
  const menu = page.getByRole("button", { name: "Open navigation" });
  await menu.click();
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await expect(navigation.getByRole("button", { name: "Tasks", exact: true })).toHaveAttribute("aria-current", "page");
  await navigation.getByRole("button", { name: "Usage", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
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
  await page.locator('[data-slot="drawer-overlay"]').click({ position: { x: width - 5, y: 180 } });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(menu).toBeFocused();
  await menu.click();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Spaces", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Spaces", exact: true })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search spaces" }).fill("palmagent");
  await assertViewportLocked(page);
  await page.getByRole("button", { name: "Close spaces" }).click();
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
  await assertViewportLocked(page);
});
