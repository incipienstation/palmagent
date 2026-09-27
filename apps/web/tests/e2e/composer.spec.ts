import { test, expect, type Locator } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

async function onScreen(control: Locator) {
  await expect(control).toBeInViewport({ ratio: 1 });
  await expect.poll(() => control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  }), { message: "control is hittable after layout and overlay transitions settle" }).toBe(true);
}

for (const width of [360, 1280]) test(`dispatch and follow-up share toolbar order and adjacent model/send controls at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 780 });
  for (const route of ["new", "task/t-idle-rich"]) {
    await page.goto(`/#/${route}`);
    const composer = page.getByRole("group", { name: "Message composer", exact: true });
    const input = composer.getByRole("textbox");
    const attachments = composer.getByRole("button", { name: "Add attachments" });
    const skills = composer.getByRole("button", { name: "Choose a skill" });
    const settings = composer.getByRole("button", { name: "Configure task settings" });
    const action = composer.getByRole("button", { name: "Send now", exact: true });
    // Focus reveals the full toolbar even before the first character.
    await input.focus();
    await composer.evaluate(async el => {
      await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
    });
    for (const draft of ["", "Review this change"]) {
      if (draft) await input.fill(draft);
      await onScreen(settings);
      await expect(action).toBeInViewport({ ratio: 1 });
      if (draft) await onScreen(action);
      await onScreen(skills);
      const [add, skill, model, send] = await Promise.all([attachments, skills, settings, action].map(control => control.boundingBox()));
      expect(skill!.x).toBeGreaterThanOrEqual(add!.x + add!.width);
      expect(skill!.width).toBeGreaterThanOrEqual(44);
      expect(model!.x).toBeGreaterThanOrEqual(skill!.x + skill!.width);
      expect(send!.width).toBeGreaterThanOrEqual(44);
      expect(send!.height).toBeGreaterThanOrEqual(44);
      const visual = action.locator("[data-send-visual]");
      await expect(visual).toHaveCSS("width", "40px");
      await expect(visual).toHaveCSS("height", "40px");
      expect(send!.x - model!.x - model!.width).toBeLessThanOrEqual(8);
      expect(Math.abs(model!.y + model!.height / 2 - send!.y - send!.height / 2)).toBeLessThanOrEqual(1);
      expect((await input.boundingBox())!.y).toBeLessThan(add!.y);
      await assertViewportLocked(page);
    }
  }
});

for (const width of [320, 360, 1280]) test(`empty composers animate between one row and the full toolbar at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 780 });
  for (const route of ["new", "task/t-run", "task/t-idle-interrupted"]) {
    await page.goto(`/#/${route}`);
    const composer = page.getByRole("group", { name: "Message composer", exact: true });
    const input = composer.getByRole("textbox");
    const height = () => composer.evaluate(el => el.getBoundingClientRect().height);
    await expect(composer).toHaveAttribute("data-expanded", "false");
    await expect.poll(height).toBe(54);
    expect(await input.evaluate(el => el.scrollHeight)).toBe(44);
    await expect(composer.getByRole("button", { name: /task settings/ })).toHaveCount(0);
    await onScreen(input);
    const add = composer.getByRole("button", { name: "Add attachments" });
    await onScreen(add);
    const action = composer.getByRole("button", { name: /^(Send now|Stop)$/ });
    const boxes = await Promise.all([add, action].map(el => el.boundingBox()));
    expect(boxes[0]!.y).toBe(boxes[1]!.y);
    expect(boxes[1]!.height).toBe(44);
    // Sample actual rendered heights, including a reversal before completion.
    const frames = await input.evaluate(async el => {
      const group = el.closest('[aria-label="Message composer"]')!;
      const sample = async (duration: number) => {
        const heights: number[] = [], start = performance.now();
        while (performance.now() - start < duration) {
          await new Promise(requestAnimationFrame);
          heights.push(group.getBoundingClientRect().height);
        }
        return heights;
      };
      el.focus(); const opening = await sample(100);
      const before = group.getBoundingClientRect().height;
      el.blur();
      await Promise.resolve();
      const after = group.getBoundingClientRect().height;
      const closing = await sample(260);
      return { opening, closing, reversal: Math.abs(after - before) };
    });
    expect(frames.opening.some(h => h > 55 && h < 109)).toBe(true);
    expect(frames.closing.some(h => h > 55 && h < 109)).toBe(true);
    expect(frames.reversal).toBeLessThan(1);
    await expect.poll(height).toBe(54);
    await input.focus();
    await expect.poll(height).toBe(110);
    await expect(input).toBeFocused();
    await expect(composer.getByRole("button", { name: /task settings/ })).toBeVisible();
    await input.fill("Keep this draft"); await input.blur();
    await expect.poll(height).toBe(110);
    await input.fill("   "); await input.blur();
    await expect.poll(height).toBe(54);
    await expect(input).toHaveValue("   ");
    await assertViewportLocked(page);
  }
});

for (const layout of [false, true]) for (const draft of ["", "Keep me"]) test(`keyboard dismissal blurs and preserves draft (${layout ? "Android" : "Safari"}, ${!!draft})`, async ({ page }) => {
  await page.goto("/#/task/t-idle-interrupted");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  const composer = page.getByRole("group", { name: "Message composer", exact: true });
  await input.fill(draft);
  const viewport = async (height: number) => page.evaluate(({ height, layout }) => {
    if (layout) Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
    Object.defineProperty(window.visualViewport, "height", { configurable: true, value: height });
    window.visualViewport!.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
  }, { height, layout });
  await viewport(730); await viewport(780);
  await expect(input).toBeFocused(); // Browser chrome alone must not blur.
  await viewport(480);
  await expect(input).toBeFocused();
  await viewport(780); // Android Back can leave the textarea focused natively.
  await expect(input).not.toBeFocused();
  await expect(input).toHaveValue(draft);
  await expect(composer).toHaveAttribute("data-expanded", String(!!draft));
  await input.focus();
  await expect(input).toBeFocused(); // Physical keyboard: no occlusion required.
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, "scale", { configurable: true, value: 2 });
    Object.defineProperty(window.visualViewport, "height", { configurable: true, value: 390 });
    window.visualViewport!.dispatchEvent(new Event("resize"));
    Object.defineProperty(window.visualViewport, "scale", { configurable: true, value: 1 });
    Object.defineProperty(window.visualViewport, "height", { configurable: true, value: 780 });
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  await expect(input).toBeFocused();
});

test("reduced motion changes composer height without animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#/new");
  const input = page.getByLabel("Prompt", { exact: true });
  await input.focus();
  await expect(input).toHaveCSS("transition-duration", "0s");
  await expect(page.getByRole("group", { name: "Message composer", exact: true })).toHaveCSS("height", "110px");
  await input.blur();
  await expect(page.getByRole("group", { name: "Message composer", exact: true })).toHaveCSS("height", "54px");
});

test("composer controls stay reachable with a keyboard and long drafts", async ({ page }) => {
  const width = 360;
  await page.setViewportSize({ width, height: 780 });
  await page.goto("/#/new");
  const prompt = page.getByLabel("Prompt", { exact: true });
  await onScreen(prompt);
  await expect(page.getByRole("button", { name: "Send now", exact: true })).toBeDisabled();
  await prompt.tap();
  await expect(prompt).toBeFocused();
  await onScreen(page.getByRole("button", { name: "Configure task settings" }));
  await prompt.blur();

  // A reduced viewport represents the space left by a software keyboard.
  await page.setViewportSize({ width, height: 480 });
  await prompt.tap();
  await onScreen(prompt);
  await page.getByRole("button", { name: "Add attachments" }).tap();
  await onScreen(page.getByRole("menuitem", { name: "Camera" }));
  await onScreen(page.getByRole("menuitem", { name: "Photos" }));
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Configure task settings" }).tap();
  await onScreen(page.getByRole("button", { name: "Done", exact: true }));
  await expect(page.getByRole("dialog")).toBeInViewport({ ratio: 1 });
  await page.getByRole("button", { name: "Done", exact: true }).tap();
  await prompt.fill("Keep this draft\n".repeat(20));
  await prompt.blur();
  await expect(prompt).toHaveValue("Keep this draft\n".repeat(20));
  await onScreen(prompt);
  await onScreen(page.getByRole("button", { name: "Send now", exact: true }));
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
  await page.getByRole("button", { name: "Configure task settings" }).tap();
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
  await onScreen(page.getByRole("button", { name: "Send now", exact: true }));
  await page.setViewportSize({ width: 1280, height: 800 });
  await assertViewportLocked(page);
  await onScreen(page.getByRole("button", { name: "Configure task settings" }));
});

test("configuration choices survive reload without losing the prompt", async ({ page }) => {
  await page.goto("/#/new");
  await page.getByLabel("Prompt").fill("Review safely");
  await page.getByRole("button", { name: "Configure task settings" }).click();
  await page.getByRole("radio", { name: "opus", exact: true }).click();
  await page.getByRole("combobox", { name: "Effort", exact: true }).click();
  await page.getByRole("option", { name: "high", exact: true }).click();
  await expect(page.getByPlaceholder("short label")).toHaveCount(0);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  await expect(page.getByLabel("Prompt")).toHaveValue("Review safely");
  await expect(page.getByRole("button", { name: "Configure task settings" })).toContainText("opus · high");
  await page.getByRole("button", { name: "Configure task settings" }).click();
  await expect(page.getByPlaceholder("short label")).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "opus", exact: true })).toHaveAttribute("aria-checked", "true");
});

test("permission picker mirrors each runtime CLI's native values", async ({ page }) => {
  await page.goto("/#/new");
  await page.getByLabel("Prompt", { exact: true }).focus();
  await page.getByRole("button", { name: "Configure task settings" }).click();

  for (const value of ["plan", "auto", "acceptEdits", "manual", "dontAsk", "bypassPermissions"]) {
    await expect(page.getByText(value, { exact: true })).toBeVisible();
  }
  await expect(page.getByText("--permission-mode acceptEdits", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("workspace-write-net", { exact: true })).toHaveCount(0);

  await page.getByRole("radio", { name: "codex", exact: true }).click();
  for (const value of ["read-only", "workspace-write", "danger-full-access"]) {
    await expect(page.getByText(value, { exact: true })).toBeVisible();
  }
  await expect(page.getByText("--sandbox workspace-write", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("workspace-write-net", { exact: true })).toHaveCount(0);
});

for (const route of ["new", "task/t-idle-rich"]) test(`image-only submission and failed-send draft retention: ${route}`, async ({ page }) => {
  await page.goto(`/#/${route}`);
  const action = page.getByRole("button", { name: "Send now", exact: true });
  const fileChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add attachments" }).click();
  await page.getByRole("menuitem", { name: "Photos" }).click();
  await (await fileChooser).setFiles({ name: "screenshot.png", mimeType: "image/png", buffer: png });
  await expect(page.getByAltText("attachment 1")).toBeVisible();
  await expect(action).toBeEnabled();
  const path = route === "new" ? "/api/tasks" : "/api/tasks/t-idle-rich/messages";
  await page.route(`**${path}`, (r) => r.fulfill({ status: 400, json: { error: "Try again" } }));
  const request = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === path);
  await action.click();
  const payload = (await request).postDataJSON();
  expect(payload.images).toHaveLength(1);
  if (route === "new") await page.getByRole("button", { name: "Edit message", exact: true }).click();
  await expect(action).toBeEnabled();
  await expect(page.getByAltText("attachment 1")).toBeVisible();
  await page.getByRole("button", { name: "Remove image 1" }).click();
  await expect(action).toBeDisabled();
});

test("follow-up settings submit only changed overrides and allow resetting to default", async ({ page }) => {
  await page.goto("/#/task/t-idle-rich");
  await page.route("**/api/tasks/t-idle-rich/messages", (r) => r.fulfill({ json: { revision: 1, paused: false, runId: null, messages: [] } }));
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Continue");
  await page.getByRole("button", { name: "Configure task settings" }).click();
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

test("Codex follow-up sends supported effort overrides and resets after changing models", async ({ page }) => {
  await page.goto("/#/task/t-idle-tokens");
  await page.route("**/api/tasks/t-idle-tokens/messages", (r) => r.fulfill({ json: { revision: 1, paused: false, runId: null, messages: [] } }));
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Continue with more reasoning");
  await page.getByRole("button", { name: "Configure task settings" }).click();
  const effort = page.getByRole("combobox", { name: "Effort", exact: true });
  await page.getByRole("radio", { name: "gpt-6-astra", exact: true }).click();
  await effort.click();
  await page.getByRole("option", { name: "ultra", exact: true }).click();
  await page.getByRole("radio", { name: "gpt-5.5", exact: true }).click();
  await expect(effort).toHaveText("default");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const request = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/messages"));
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  expect((await request).postDataJSON().settings).toEqual({ effort: "" });
});
