import { test, expect, type Page } from "@playwright/test";
import { installScopedStream, open, send, event, viewport, expectBottom } from "./_session-stream";

test.use({ serviceWorkers: "block" });
test.beforeEach(async ({ page }) => installScopedStream(page));
const button = (page: Page) => page.getByRole("button", { name: "Scroll to bottom", exact: true });

async function longConversation(page: Page) {
  await open(page, "t-idle-rich");
  await send(page, "t-idle-rich", { type: "tasks", tasks: [], historyThrough: 0 });
  await event(page, "t-idle-rich", 1, "Reading a long conversation\n\n".repeat(100));
  await expectBottom(page);
  await expect(button(page)).toBeHidden();
}

async function readAbove(page: Page, distance = 450) {
  const bounds = await viewport(page).boundingBox();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await page.mouse.wheel(0, -distance);
  await expect(button(page)).toBeVisible();
  // Wait for native wheel scrolling to finish before recording the reading position.
  await expect.poll(() => viewport(page).evaluate(async el => {
    const top = el.scrollTop;
    for (let i = 0; i < 4; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    return Math.abs(el.scrollTop - top);
  })).toBeLessThanOrEqual(1);
}

test("returning to latest preserves the draft and resumes streaming follow", async ({ page }) => {
  await longConversation(page);
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("My unfinished draft");
  await readAbove(page);
  const top = await viewport(page).evaluate(el => el.scrollTop);
  await event(page, "t-idle-rich", 2, "New output while reading\n\n".repeat(12));
  await expect(page.getByText("New output while reading", { exact: true })).toHaveCount(12);
  await expect.poll(() => viewport(page).evaluate(el => el.scrollTop)).toBe(top);
  await button(page).click();
  await expectBottom(page);
  await expect(button(page)).toBeHidden();
  await expect(input).toHaveValue("My unfinished draft");
  await expect(input).toBeFocused();
  await event(page, "t-idle-rich", 3, "Continuing at the bottom\n\n".repeat(12));
  await expectBottom(page);
  await expect(button(page)).toBeHidden();
});

test("the translucent control stays above the composer in both themes and a smaller viewport", async ({ page }) => {
  await longConversation(page);
  await readAbove(page);
  await page.setViewportSize({ width: 360, height: 520 });
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("A multiline draft\n".repeat(4));
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => { document.documentElement.classList.toggle("dark", theme === "dark"); }, theme);
    await expect(button(page)).toBeVisible();
    const control = await button(page).boundingBox();
    const transcript = await viewport(page).boundingBox();
    const composer = await page.getByRole("group", { name: "Message composer", exact: true }).boundingBox();
    expect(Math.abs(control!.x + control!.width / 2 - (transcript!.x + transcript!.width / 2))).toBeLessThan(1);
    expect(control!.y + control!.height).toBeLessThan(composer!.y);
    expect(control!.width).toBe(40);
    const style = await button(page).evaluate(el => ({
      background: getComputedStyle(el).backgroundColor,
      opacity: getComputedStyle(el).opacity,
      blur: getComputedStyle(el).backdropFilter,
    }));
    expect(style.background).toMatch(/(?:0\.7|70%)/);
    expect(style.opacity).toBe("1");
    expect(style.blur).toBe("none");
  }
  await button(page).tap();
  await expectBottom(page);
  await expect(input).toHaveValue("A multiline draft\n".repeat(4));
});

test("keyboard activation supports reduced motion without focusing the composer", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await longConversation(page);
  await readAbove(page);
  await button(page).focus();
  await page.keyboard.press("Enter");
  await expectBottom(page);
  await expect(button(page)).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).not.toBeFocused();
  await expect(viewport(page)).toBeFocused();
});

test("upward input interrupts the short return animation", async ({ page }) => {
  await longConversation(page);
  await readAbove(page, 220);
  // Trigger input in the next animation frame, before the 180ms return finishes.
  const top = await button(page).evaluate(el => new Promise<number>(resolve => {
    (el as HTMLButtonElement).click();
    requestAnimationFrame(() => {
      const transcript = document.querySelector<HTMLElement>('[aria-label="Session transcript"]')!;
      transcript.dispatchEvent(new WheelEvent("wheel", { deltaY: -200 }));
      // Capture after cancellation, not while the first animation frame is
      // still queued: that frame is allowed to advance before the input.
      resolve(transcript.scrollTop);
    });
  }));
  await expect(button(page)).toBeVisible();
  await event(page, "t-idle-rich", 2, "Output after interruption\n\n".repeat(8));
  await expect(page.getByText("Output after interruption", { exact: true })).toHaveCount(8);
  await expect.poll(() => viewport(page).evaluate(el => el.scrollTop)).toBe(top);
  await button(page).click();
  await expectBottom(page);
});
