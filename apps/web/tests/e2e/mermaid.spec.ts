import { test, expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { assertViewportLocked } from "./_helpers";
import { installScopedStream, open, send } from "./_scoped-stream";
import { viewport } from "./_session-stream";

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

test("signing into a new session renders diagrams again instead of reusing the old cache", async ({ page }) => {
  const taskId = await reply(page, fence(flow));
  const diagram = page.getByRole("img", { name: "Mermaid diagram", exact: true });
  await expect(diagram).toBeVisible();
  const previous = await diagram.getAttribute("src");
  await page.route(`**/api/tasks/${taskId}/history?*`, route => route.fulfill({ json: {
    events: [{ seq: 1, event: { taskId, agent: "codex", ts: 1, kind: "assistant_text", payload: { text: fence(flow) } } }],
    before: null, cursor: 1,
  } }));
  await page.route("**/api/auth/login/options", route => route.fulfill({ json: { challenge: "Y2hhbGxlbmdl" } }));
  await page.route("**/api/auth/login/verify", route => route.fulfill({ json: { verified: true } }));
  await page.evaluate(() => {
    Object.defineProperty(navigator.credentials, "get", { configurable: true, value: async () => ({
      id: "test-credential", rawId: new Uint8Array([1]).buffer, type: "public-key",
      response: { authenticatorData: new Uint8Array([1]).buffer, clientDataJSON: new Uint8Array([1]).buffer, signature: new Uint8Array([1]).buffer },
      getClientExtensionResults: () => ({}),
    }) });
  });
  const other = await page.context().newPage();
  try {
    await other.goto(new URL("/manifest.webmanifest", page.url()).href);
    await other.evaluate(() => {
      const channel = new BroadcastChannel("palmagent-cache");
      channel.postMessage("session"); channel.close();
    });
    await page.getByRole("button", { name: "Sign in with passkey" }).click();
    await expect(diagram).toBeVisible();
    await expect(diagram).not.toHaveAttribute("src", previous!);
  } finally { await other.close(); }
});

test("long Markdown renders Mermaid and preserves source and ordinary code", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const prefix = "<!--" + "x".repeat(4100) + "-->\n\n";
  await reply(page, prefix + fence(flow) + '\n\n```js\nconst value = 1;\n```');
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

test("wheel zoom requires a modifier and zoom is bounded", async ({ page }) => {
  await reply(page, fence(flow));
  await page.getByRole("button", { name: "Open diagram fullscreen" }).click();
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
  // The modal scroll lock may cancel ordinary wheel input; it must not zoom.
  await wheel(null);
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

for (const input of ["touch", "wheel"] as const) {
  test(`inline diagrams let native ${input} scroll the conversation`, async ({ page, context }) => {
    await reply(page, "Before the diagram.\n\n".repeat(20) + fence(flow) + "\n\nAfter the diagram.".repeat(20));
    const canvas = page.getByRole("region", { name: "Mermaid diagram", exact: true });
    await expect(canvas).toBeVisible();
    await canvas.evaluate(el => el.scrollIntoView({ block: "center" }));
    const pane = viewport(page);
    const before = await pane.evaluate(el => el.scrollTop);
    const box = (await canvas.boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    if (input === "touch") {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 0 }] });
      for (let delta = 10; delta <= 100; delta += 10) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - delta, id: 0 }] });
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await cdp.detach();
    } else {
      await page.mouse.move(x, y);
      await page.mouse.wheel(0, 140);
    }
    await expect.poll(() => pane.evaluate(el => el.scrollTop)).toBeGreaterThan(before + 40);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Zoom in diagram" })).toHaveCount(0);
    await assertViewportLocked(page);
  });
}

test("wide previews stay compact and fullscreen is keyboard accessible", async ({ page }) => {
  await reply(page, fence("flowchart LR\n A[Start] --> B[Prepare] --> C[Process] --> D[Review] --> E[Finish]"));
  const canvas = page.getByRole("region", { name: "Mermaid diagram", exact: true });
  await expect(canvas).toBeVisible();
  expect((await canvas.boundingBox())!.height).toBeLessThanOrEqual(256);
  await expect(page.getByRole("group", { name: "Diagram zoom controls" })).toHaveCount(0);
  await expect(page.getByText("Drag to pan", { exact: false })).toHaveCount(0);
  await screenshot(page, "mermaid-compact-wide-mobile");
  const trigger = page.getByRole("button", { name: "Open diagram fullscreen" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Mermaid diagram" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});
