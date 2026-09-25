import { test, expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { assertViewportLocked } from "./_helpers";
import { installScopedStream, open, send } from "./_scoped-stream";

test.use({ serviceWorkers: "block" });

async function reply(page: Page, text: string, running = false) {
  await installScopedStream(page);
  const taskId = running ? "t-run-charts" : "t-idle-rich";
  await open(page, taskId);
  await send(page, taskId, { type: "tasks", tasks: [], historyThrough: 0 });
  await send(page, taskId, { type: "event", event: {
    taskId, agent: "codex", ts: 1, kind: "assistant_text", payload: { text, messageId: "mermaid-reply" },
  } }, 1);
  return taskId;
}

async function screenshot(page: Page, name: string) {
  if (process.env.VISUAL_REVIEW_DIR) {
    await page.screenshot({ path: join(process.env.VISUAL_REVIEW_DIR, `${name}.png`) });
  }
}

const fence = (source: string) => "```mermaid\n" + source + "\n```";
const flow = "flowchart TD\n  A[Start] --> B[Render diagram]\n  B --> C[Done]";

test("Mermaid parsing keeps the transcript row height stable", async ({ page }) => {
  await reply(page, fence(flow));
  const block = page.locator("[data-mermaid-block]");
  await expect(block.getByText("Rendering diagram…")).toBeVisible();
  const before = (await block.boundingBox())!.height;
  await expect(page.getByRole("img", { name: "Mermaid diagram", exact: true })).toBeVisible();
  const after = (await block.boundingBox())!.height;
  expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
});

for (const parser of ["static", "streaming", "long"] as const) {
  test(`${parser} Markdown renders Mermaid and preserves source and ordinary code`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const prefix = parser === "long" ? "<!--" + "x".repeat(4100) + "-->\n\n" : "";
    await reply(page, prefix + fence(flow) + '\n\n```js\nconst value = 1;\n```', parser === "streaming");
    const diagram = page.getByRole("img", { name: "Mermaid diagram", exact: true });
    await expect(diagram).toBeVisible();
    await expect.poll(() => diagram.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    const svg = decodeURIComponent((await diagram.getAttribute("src"))!.split(",").slice(1).join(","));
    expect(svg.replace(/<[^>]*>/g, "")).toContain("Render diagram");
    expect(svg).not.toContain("<foreignObject");
    await expect(page.locator("pre").filter({ hasText: "const value = 1;" })).toBeVisible();
    await page.getByText("Diagram source", { exact: true }).click();
    await expect(page.locator("pre").filter({ hasText: flow })).toBeVisible();
    await assertViewportLocked(page);
    expect(errors).toEqual([]);
  });
}

test("an incomplete streaming diagram recovers when the fence is completed", async ({ page }) => {
  const taskId = await reply(page, '```mermaid\nflowchart TD\n A[', true);
  await expect(page.getByText("Diagram unavailable — showing source.")).toBeVisible();
  await send(page, taskId, { type: "event", event: {
    taskId, agent: "codex", ts: 2, kind: "assistant_text", payload: { text: "Ready] --> B[Done]\n```", messageId: "mermaid-reply" },
  } }, 2);
  await expect(page.getByRole("img", { name: "Mermaid diagram", exact: true })).toBeVisible();
  await expect(page.getByText("Diagram unavailable — showing source.")).toHaveCount(0);
  await expect(page.locator('body > div[aria-hidden="true"]')).toHaveCount(0);
});

test("multiple diagrams, theme changes, and wide mobile content remain contained", async ({ page }) => {
  await reply(page, fence(flow) + "\n\n" + fence("sequenceDiagram\n Alice->>Bob: Hello\n Bob->>Charlie: Forward\n Charlie->>Diana: Forward\n Diana-->>Alice: Welcome"));
  const diagrams = page.getByRole("img", { name: "Mermaid diagram", exact: true });
  await expect(diagrams).toHaveCount(2);
  await expect.poll(() => diagrams.last().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(360);
  const dark = await diagrams.first().getAttribute("src");
  await screenshot(page, "mermaid-mobile-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(diagrams).toHaveCount(2);
  await expect(diagrams.first()).not.toHaveAttribute("src", dark!);
  await screenshot(page, "mermaid-mobile-light");
  await assertViewportLocked(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await screenshot(page, "mermaid-desktop-light");
  const light = await diagrams.first().getAttribute("src");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(diagrams).toHaveCount(2);
  await expect(diagrams.first()).not.toHaveAttribute("src", light!);
  await screenshot(page, "mermaid-desktop-dark");
});

test("diagram directives cannot enable HTML or executable links", async ({ page }) => {
  let dialogs = 0;
  page.on("dialog", async dialog => { dialogs++; await dialog.dismiss(); });
  await reply(page, fence('%%{init: {"securityLevel":"loose", "htmlLabels":true, "flowchart":{"htmlLabels":true}}}%%\nflowchart TD\n A[Safe] --> B[Text]\n click A "javascript:alert(1)"'));
  const diagram = page.getByRole("img", { name: "Mermaid diagram", exact: true });
  await expect(diagram).toBeVisible();
  const svg = decodeURIComponent((await diagram.getAttribute("src"))!.split(",").slice(1).join(","));
  expect(svg).not.toContain("<foreignObject");
  expect(svg).not.toContain("javascript:");
  await page.getByRole("region", { name: "Mermaid diagram", exact: true }).click();
  expect(dialogs).toBe(0);
});

async function transform(page: Page) {
  return page.getByRole("img", { name: "Mermaid diagram", exact: true }).evaluate(img => {
    const matrix = new DOMMatrix(getComputedStyle(img.parentElement!).transform);
    return { scale: matrix.a, x: matrix.e, y: matrix.f };
  });
}

test("diagram controls zoom, mouse drag pans, and fit restores the initial view", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await reply(page, fence(flow));
  const canvas = page.getByRole("region", { name: "Mermaid diagram", exact: true });
  await expect(canvas).toBeVisible();
  await canvas.scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Zoom out diagram" })).toBeDisabled();
  const initial = await transform(page);
  await page.getByRole("button", { name: "Zoom in diagram" }).click();
  await expect.poll(async () => (await transform(page)).scale).toBeGreaterThan(1);
  const zoomed = await transform(page);
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 65, box.y + box.height / 2 - 40, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await transform(page)).x).toBeLessThan(zoomed.x - 30);
  await expect.poll(async () => (await transform(page)).y).toBeLessThan(zoomed.y - 20);
  await screenshot(page, "mermaid-pan-desktop-dark");
  await page.getByRole("button", { name: "Fit diagram" }).click();
  await expect.poll(() => transform(page)).toEqual(initial);
  // Keyboard controls work without requiring a pointer gesture.
  await canvas.focus();
  await page.keyboard.press("+");
  await expect.poll(async () => (await transform(page)).scale).toBeGreaterThan(1);
  const beforeArrow = await transform(page);
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await transform(page)).x).toBeLessThan(beforeArrow.x);
  await page.keyboard.press("0");
  await expect.poll(() => transform(page)).toEqual(initial);
  const diagram = page.getByRole("img", { name: "Mermaid diagram", exact: true });
  const darkSource = await diagram.getAttribute("src");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(diagram).not.toHaveAttribute("src", darkSource!);
  await expect(page.getByRole("button", { name: "Zoom in diagram" })).toBeVisible();
  await screenshot(page, "mermaid-pan-desktop-light");
  await assertViewportLocked(page);
});

for (const fullscreen of [false, true]) {
test(`native pinch and pan stay inside the ${fullscreen ? "fullscreen" : "inline"} diagram`, async ({ page, context }) => {
  await reply(page, fence(flow));
  if (fullscreen) await page.getByRole("button", { name: "Open diagram fullscreen" }).click();
  const canvas = page.getByRole("region", { name: "Mermaid diagram", exact: true });
  await expect(canvas).toBeVisible();
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const cdp = await context.newCDPSession(page);
  const points = (radius: number) => [{ x: x - radius, y, id: 0 }, { x: x + radius, y, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(35) });
  for (let radius = 40; radius <= 90; radius += 10) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(radius) });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(async () => (await transform(page)).scale).toBeGreaterThan(1.5);
  const pinched = await transform(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 0 }] });
  for (let delta = 10; delta <= 50; delta += 10) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - delta, y: y - delta, id: 0 }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(async () => (await transform(page)).x).toBeLessThan(pinched.x - 20);
  await expect.poll(async () => (await transform(page)).y).toBeLessThan(pinched.y - 20);
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
  await screenshot(page, fullscreen ? "mermaid-fullscreen-pinch-mobile-dark" : "mermaid-pinch-mobile-dark");
  // Reverse pinch returns toward fit without shrinking below it.
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(90) });
  for (let radius = 80; radius >= 10; radius -= 10) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(radius) });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(async () => (await transform(page)).scale).toBe(1);
  if (fullscreen) await page.getByRole("button", { name: "Exit diagram fullscreen" }).click();
  const diagram = page.getByRole("img", { name: "Mermaid diagram", exact: true });
  const darkSource = await diagram.getAttribute("src");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(diagram).not.toHaveAttribute("src", darkSource!);
  await expect(page.getByRole("button", { name: "Zoom in diagram" })).toBeVisible();
  await screenshot(page, "mermaid-pinch-mobile-light");
  await assertViewportLocked(page);
  await cdp.detach();
});
}

test("wheel zoom requires a modifier and zoom is bounded", async ({ page }) => {
  await reply(page, fence(flow));
  const canvas = page.getByRole("region", { name: "Mermaid diagram", exact: true });
  await expect(canvas).toBeVisible();
  // Trackpads emit Ctrl+wheel for a pinch without a keyboard keydown event.
  const wheel = (modifier: "Control" | "Meta" | null) => canvas.evaluate((el, modifier) => {
    const box = el.getBoundingClientRect();
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100,
      clientX: box.x + box.width / 2, clientY: box.y + box.height / 2,
      ctrlKey: modifier === "Control", metaKey: modifier === "Meta" });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  }, modifier);
  expect(await wheel(null)).toBe(false);
  expect((await transform(page)).scale).toBe(1);
  expect(await wheel("Control")).toBe(true);
  await expect.poll(async () => (await transform(page)).scale).toBeGreaterThan(1);
  const controlScale = (await transform(page)).scale;
  expect(await wheel("Meta")).toBe(true);
  await expect.poll(async () => (await transform(page)).scale).toBeGreaterThan(controlScale);
  for (let index = 0; index < 20; index++) {
    const zoomIn = page.getByRole("button", { name: "Zoom in diagram" });
    if (await zoomIn.isEnabled()) await zoomIn.click();
  }
  await expect(page.getByRole("button", { name: "Zoom in diagram" })).toBeDisabled();
  expect((await transform(page)).scale).toBe(8);
  await page.getByRole("button", { name: "Fit diagram" }).click();
  expect((await transform(page)).scale).toBe(1);
});

for (const viewport of [{ width: 360, height: 780 }, { width: 1280, height: 900 }]) {
  test(`fullscreen fills the ${viewport.width}px viewport and restores inline controls`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await reply(page, fence(flow));
    const trigger = page.getByRole("button", { name: "Open diagram fullscreen" });
    const diagram = page.getByRole("img", { name: "Mermaid diagram", exact: true });
    for (const theme of ["dark", "light"] as const) {
      if (theme === "light") {
        const previous = await diagram.getAttribute("src");
        await page.emulateMedia({ colorScheme: theme });
        await expect(diagram).not.toHaveAttribute("src", previous!);
      }
      await expect(trigger).toBeVisible();
      await page.getByRole("button", { name: "Fit diagram" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.getByRole("button", { name: "Zoom in diagram" }).click();
      const inline = await transform(page);
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "Mermaid diagram", exact: true });
      await expect(dialog).toBeVisible();
      await expect.poll(async () => {
        const box = (await dialog.boundingBox())!;
        return Object.fromEntries(Object.entries(box).map(([key, value]) => [key, Math.round(value)]));
      }).toEqual({ x: 0, y: 0, ...viewport });
      const canvas = dialog.getByRole("region", { name: "Mermaid diagram", exact: true });
      expect((await canvas.boundingBox())!.height).toBeGreaterThan(viewport.height * 0.65);
      expect((await transform(page)).scale).toBe(1);
      await canvas.focus();
      await page.keyboard.press("+");
      await expect.poll(async () => (await transform(page)).scale).toBeGreaterThan(1);
      await dialog.getByRole("button", { name: "Fit diagram" }).click();
      await screenshot(page, `mermaid-fullscreen-${viewport.width}-${theme}`);
      // Focus stays in the dialog; Escape restores the trigger and its view.
      await dialog.getByRole("button", { name: "Exit diagram fullscreen" }).focus();
      await page.keyboard.press("Shift+Tab");
      await expect(canvas).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      expect(await transform(page)).toEqual(inline);
      await trigger.click();
      await expect(dialog).toBeVisible();
      if (viewport.width === 360) {
        await page.setViewportSize({ width: 780, height: 360 });
        await expect(dialog).toHaveCSS("height", "360px");
        await expect(dialog).toHaveCSS("width", "780px");
      }
      await dialog.getByRole("button", { name: "Exit diagram fullscreen" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await page.setViewportSize(viewport);
      await assertViewportLocked(page);
    }
  });
}
