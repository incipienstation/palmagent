import { test, expect } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";

for (const width of [320, 1280]) {
  test(`task header preserves conversation space and details at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 780 });
    await page.goto("/#/task/t-idle-rich");
    const title = page.getByTitle("Session details", { exact: true });
    await expect(title).toBeVisible();
    await expect(page.locator("header").getByText("Done", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Release to shell" })).toBeHidden();
    expect((await title.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const actions = page.getByRole("group", { name: "Header actions" });
    await expect(actions).toBeVisible();
    await expect(actions).toHaveCSS("border-top-style", "solid");
    const taskActions = actions.getByRole("button", { name: "Task actions" });
    const navigation = actions.getByRole("button", { name: "Open navigation" });
    await expect(taskActions).toBeVisible();
    await expect(navigation).toBeVisible();
    expect((await taskActions.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await navigation.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await actions.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await assertViewportLocked(page);

    const composer = page.getByPlaceholder("Send a follow-up turn…");
    await composer.fill("Keep my draft while checking this session");
    await title.click();
    const details = page.getByRole("dialog", { name: "Session details" });
    await expect(details.getByText("Branch", { exact: true })).toBeVisible();
    await expect(details.getByText("Model", { exact: true })).toBeVisible();
    await expect(details.getByRole("link", { name: /Wire the web QA harness/ })).toBeVisible();
    await details.getByRole("button", { name: "Release to shell" }).scrollIntoViewIfNeeded();
    await expect(details.getByRole("button", { name: "Release to shell" })).toBeInViewport();
    await assertViewportLocked(page);
    await page.keyboard.press("Escape");
    await expect(title).toBeFocused();
    await expect(composer).toHaveValue("Keep my draft while checking this session");

    // Reduced viewport approximates the space available above a phone keyboard.
    await page.setViewportSize({ width, height: 480 });
    await composer.focus();
    await expect(composer).toBeInViewport();
    await expect(page.getByText("Harness scaffolded and passing.", { exact: true })).toBeInViewport();
    await assertViewportLocked(page);
  });
}
