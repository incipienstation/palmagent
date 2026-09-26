import { test, expect } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";

for (const width of [320, 1280]) {
  test(`task conversation uses the compact reference header at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 780 });
    await page.goto("/#/task/t-idle-rich");
    await expect(page.getByText("Harness scaffolded and passing.", { exact: true })).toBeVisible();

    const header = page.locator("header").first();
    const title = header.getByRole("heading", { name: "Wire the web QA harness", exact: true });
    await expect(title).toHaveClass(/sr-only/);
    expect((await title.boundingBox())!.height).toBeLessThanOrEqual(1);
    await expect(header.getByText("Done", { exact: true })).toHaveCount(0);

    const navigation = header.getByRole("button", { name: "Open navigation", exact: true });
    const actions = page.getByRole("group", { name: "Header actions" });
    const compose = actions.getByRole("button", { name: "New task", exact: true });
    const taskActions = actions.getByRole("button", { name: "Task actions", exact: true });
    await expect(navigation).toBeVisible();
    await expect(header.getByRole("button", { name: "Back", exact: true })).toHaveCount(0);
    await expect(compose).toBeVisible();
    await expect(taskActions).toBeVisible();
    await expect(actions).toHaveCSS("border-top-style", "solid");
    const actionBounds = (await actions.boundingBox())!;
    expect(actionBounds.width).toBeGreaterThanOrEqual(88);
    expect(actionBounds.width).toBeLessThanOrEqual(96);
    for (const control of [navigation, compose, taskActions]) {
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }

    const fade = header.locator(":scope > div[aria-hidden='true']");
    const fadeStyle = await fade.evaluate(element => ({
      backgroundImage: getComputedStyle(element).backgroundImage,
      backdropFilter: getComputedStyle(element).backdropFilter,
      height: element.getBoundingClientRect().height,
    }));
    expect(fadeStyle.backgroundImage).toContain("linear-gradient");
    expect(fadeStyle.backdropFilter).toBe("none");
    expect(fadeStyle.height).toBeGreaterThan((await header.boundingBox())!.height);

    const transcript = page.locator("[data-radix-scroll-area-viewport]").first();
    const topImage = await fade.evaluate(element => getComputedStyle(element).backgroundImage);
    const scrollRange = await transcript.evaluate(element => element.scrollHeight - element.clientHeight);
    if (scrollRange > 0) {
      await transcript.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
      expect(await transcript.evaluate(element => element.scrollTop)).toBe(0);
      await transcript.evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event("scroll")); });
      expect(await transcript.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    }
    const scrolledImage = await fade.evaluate(element => getComputedStyle(element).backgroundImage);
    expect(scrolledImage).toBe(topImage);

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
    await expect(page).toHaveURL(/#\/new$/);
    await expect(page.getByRole("heading", { name: "New task", exact: true })).toBeVisible();
  });
}
