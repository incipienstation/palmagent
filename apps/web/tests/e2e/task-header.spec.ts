import { test, expect } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";

for (const width of [320, 1280]) {
  test(`task header keeps navigation and session actions accessible at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 780 });
    await page.goto("/#/task/t-idle-rich");
    await expect(page.getByText("Harness scaffolded and passing.", { exact: true })).toBeVisible();

    const header = page.locator("header").first();
    const title = header.getByRole("heading", { name: "Wire the web QA harness", exact: true });
    await expect(title).toHaveCount(1);
    await expect(header.getByText("Done", { exact: true })).toHaveCount(0);

    const navigation = header.getByRole("button", { name: "Open navigation", exact: true });
    const actions = page.getByRole("group", { name: "Header actions" });
    const compose = actions.getByRole("button", { name: "New task", exact: true });
    const taskActions = actions.getByRole("button", { name: "Task actions", exact: true });
    if (width < 768) await expect(navigation).toBeVisible();
    else await expect(page.getByRole("button", { name: "Collapse navigation", exact: true })).toBeVisible();
    await expect(header.getByRole("button", { name: "Back", exact: true })).toHaveCount(0);
    await expect(compose).toBeVisible();
    await expect(taskActions).toBeVisible();
    for (const control of [...(width < 768 ? [navigation] : []), compose, taskActions]) {
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }

    await taskActions.click();
    await page.getByRole("menuitem", { name: "Session details", exact: true }).click();
    const details = page.getByRole("dialog", { name: "Session details" });
    await expect(details.getByText("Branch", { exact: true })).toBeVisible();
    await expect(details.getByText("Model", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(details).toBeHidden();
    await expect(taskActions).toBeFocused();

    await assertViewportLocked(page);
    await compose.click();
    await expect(page).toHaveURL(/#\/new(?:\/space\/repo-app)?$/);
    await expect(page.getByRole("heading", { name: "New task", exact: true })).toBeVisible();
  });
}
