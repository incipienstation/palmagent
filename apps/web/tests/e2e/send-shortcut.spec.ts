import { test, expect, type Page } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false, serviceWorkers: "block" });

async function settings(page: Page) {
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  return page.getByRole("radiogroup", { name: "Send message with" });
}

for (const route of ["new", "task/t-idle-rich"] as const) {
  const path = route === "new" ? "/api/tasks" : "/api/tasks/t-idle-rich/messages";
  const label = route === "new" ? "Prompt" : "Message";

  for (const key of ["Control+Enter", "Meta+Enter"]) {
    test(`${key} submits ${route} and preserves a failed draft`, async ({ page }) => {
      const calls: Record<string, unknown>[] = [];
      await page.route(`**${path}`, async r => {
        calls.push(r.request().postDataJSON());
        await r.fulfill({ status: 503, json: { error: "Try again" } });
      });
      await page.goto(`/#/${route}`);
      const input = page.getByRole("textbox", { name: label, exact: true });
      await input.fill("Review this");
      await input.press("Enter");
      await input.press("Shift+Enter");
      await expect(input).toHaveValue("Review this\n\n");
      expect(calls).toHaveLength(0);
      await input.press(key);
      await expect.poll(() => calls.length).toBe(1);
      expect(calls[0][route === "new" ? "prompt" : "text"]).toBe("Review this");
      await expect(input).toBeEnabled();
      await expect(input).toHaveValue("Review this\n\n");
    });
  }

  test(`Enter preference immediately applies to ${route} and survives reload`, async ({ page }) => {
    const calls: unknown[] = [];
    await page.route(`**${path}`, async r => {
      calls.push(r.request().postDataJSON());
      await r.fulfill({ status: 503, json: { error: "Try again" } });
    });
    await page.goto(`/#/${route}`);
    const input = page.getByRole("textbox", { name: label, exact: true });
    await input.fill("Keep this draft");
    const options = await settings(page);
    await expect(options.getByRole("radio", { name: "Cmd/Ctrl + Enter", exact: true })).toBeChecked();
    const enter = options.getByRole("radio", { name: "Enter", exact: true });
    await enter.click();
    await enter.click();
    await expect(enter).toBeChecked();
    await page.getByRole("button", { name: "Close settings" }).click();
    await input.press("Shift+Enter");
    await expect(input).toHaveValue("Keep this draft\n");
    expect(calls).toHaveLength(0);
    await input.press("Enter");
    await expect.poll(() => calls.length).toBe(1);
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue("Keep this draft\n");
    await page.reload();
    await expect(input).toHaveAttribute("aria-keyshortcuts", "Enter Meta+Enter Control+Enter");
    await input.fill("After reload");
    await input.press("Enter");
    await expect.poll(() => calls.length).toBe(2);
    await expect(input).toBeEnabled();
    const restored = await settings(page);
    await expect(restored.getByRole("radio", { name: "Enter", exact: true })).toBeChecked();
    await restored.getByRole("radio", { name: "Cmd/Ctrl + Enter", exact: true }).click();
    await page.getByRole("button", { name: "Close settings" }).click();
    // Failed optimistic sends restore the value, not the previous caret position.
    await input.press("End");
    await input.press("Enter");
    await expect(input).toHaveValue("After reload\n");
    expect(calls).toHaveLength(2);
  });
}

for (const shortcut of ["enter", "modifier-enter"]) {
  test(`${shortcut} protects composition, empty drafts, modified newlines and held keys`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem("pref:send-shortcut", value), shortcut);
    let sends = 0;
    await page.route("**/api/tasks", async r => {
      sends++;
      await r.fulfill({ status: 503, json: { error: "Try again" } });
    });
    await page.goto("/#/new");
    const input = page.getByRole("textbox", { name: "Prompt", exact: true });
    const key = shortcut === "enter" ? "Enter" : "Control+Enter";
    await input.fill("   ");
    await input.press(key);
    await input.fill("한글");
    await input.dispatchEvent("compositionstart");
    await input.press(key);
    await input.dispatchEvent("compositionend", { data: "한글" });
    await input.dispatchEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true });
    await input.dispatchEvent("keydown", { key: "Enter", ctrlKey: true, keyCode: 229 });
    await input.dispatchEvent("keydown", { key: "Enter", ctrlKey: true, repeat: true });
    await input.press("Control+Shift+Enter");
    await input.press("Alt+Enter");
    expect(sends).toBe(0);
    await input.fill("완성");
    await input.press(key);
    await expect.poll(() => sends).toBe(1);
  });
}

test("shortcut sends image-only messages once while a request is pending", async ({ page }) => {
  let sends = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/tasks/t-idle-rich/messages", async r => {
    sends++;
    expect(r.request().postDataJSON().images).toHaveLength(1);
    await held;
    await r.fulfill({ status: 503, json: { error: "Try again" } });
  });
  try {
    await page.goto("/#/task/t-idle-rich");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Add attachments" }).click();
    await page.getByRole("menuitem", { name: "Photos" }).click();
    await (await chooser).setFiles({ name: "image.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64") });
    await expect(page.getByAltText("attachment 1")).toBeVisible();
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await input.press("Control+Enter");
    await expect(input).toBeDisabled();
    await expect.poll(() => sends).toBe(1);
    await page.keyboard.press("Control+Enter");
    expect(sends).toBe(1);
  } finally { release(); }
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeEnabled();
  await expect(page.getByAltText("attachment 1")).toBeVisible();
});

test("unrecognized stored shortcuts fall back to Cmd/Ctrl + Enter", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pref:send-shortcut", "unknown"));
  await page.goto("/#/new");
  const input = page.getByRole("textbox", { name: "Prompt", exact: true });
  await expect(input).toHaveAttribute("aria-keyshortcuts", "Meta+Enter Control+Enter");
});
