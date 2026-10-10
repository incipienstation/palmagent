import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { assertViewportLocked, captureForReview } from "./_helpers";
import { installScopedStream, open, send } from "./_scoped-stream";

test.use({ serviceWorkers: "block" });

const png = readFileSync(new URL("../../public/icon-512.png", import.meta.url));
async function reply(page: Page, text: string, running = false) {
  await installScopedStream(page);
  await open(page, running ? "t-run-charts" : "t-idle-rich");
  const taskId = running ? "t-run-charts" : "t-idle-rich";
  await send(page, taskId, { type: "tasks", tasks: [], historyThrough: 0 });
  await send(page, taskId, { type: "event", event: {
    taskId, agent: "codex", ts: 1, kind: "assistant_text", payload: { text, phase: "final", messageId: "image-reply" },
  } }, 1);
  return taskId;
}

for (const parser of ["static", "streaming", "long"] as const) {
  test(`${parser} Markdown resolves sandbox images through the task image endpoint`, async ({ page }) => {
    const paths: string[] = [];
    await page.route("**/api/tasks/*/image?*", route => {
      const path = new URL(route.request().url()).searchParams.get("path")!;
      paths.push(path);
      return path === "/workspace/preview #1.png"
        ? route.fulfill({ contentType: "image/png", body: png })
        : route.fulfill({ status: 404, body: "unavailable" });
    });
    const prefix = parser === "long" ? "<!--" + "x".repeat(4100) + "-->\n\n" : "";
    const taskId = await reply(page, prefix + [
      "![Sandbox preview](<sandbox:/workspace/preview%20%231.png>)",
      "![Missing sandbox file](sandbox:/mnt/data/missing.png)",
      "![Sandbox host](sandbox://example.invalid/preview.png)",
      "![Nested scheme](sandbox:https://example.invalid/preview.png)",
      "![Relative sandbox](sandbox:preview.png)",
    ].join("\n\n"), parser === "streaming");
    const preview = page.getByRole("button", { name: "Enlarge image: Sandbox preview" });
    await expect(preview).toBeVisible();
    await expect(preview.locator("img")).toHaveAttribute("src",
      `/api/tasks/${taskId}/image?${new URLSearchParams({ path: "/workspace/preview #1.png" })}`);
    await expect.poll(() => preview.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(512);
    for (const label of ["Missing sandbox file", "Sandbox host", "Nested scheme", "Relative sandbox"]) {
      await expect(page.getByText(`Image unavailable: ${label}`, { exact: true })).toBeVisible();
    }
    expect(paths).toContain("/workspace/preview #1.png");
    expect(paths).toContain("/mnt/data/missing.png");
    expect(paths.every(path => ["/workspace/preview #1.png", "/mnt/data/missing.png"].includes(path))).toBe(true);
    await assertViewportLocked(page);
    await captureForReview(page, `sandbox-image-${parser}.png`);
    await preview.click();
    const dialog = page.getByRole("dialog", { name: "Sandbox preview", exact: true });
    await expect(dialog).toBeVisible();
    const close = dialog.getByRole("button", { name: "Exit image fullscreen", exact: true });
    const closeBox = (await close.boundingBox())!;
    expect(closeBox.width).toBeGreaterThanOrEqual(44);
    expect(closeBox.height).toBeGreaterThanOrEqual(44);
    await expect(close).toBeInViewport({ ratio: 1 });
    await expect.poll(() => dialog.getByRole("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(512);
  });

  test(`${parser} Markdown renders local images and opens an accessible preview`, async ({ page }) => {
    const requests: string[] = [];
    await page.route("**/api/tasks/*/image?*", route => {
      requests.push(route.request().url());
      return route.fulfill({ contentType: "image/png", body: png });
    });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const prefix = parser === "long" ? "<!--" + "x".repeat(4100) + "-->\n\n" : "";
    const taskId = await reply(page, prefix + "Here is the preview.\n\n![Preview](<images/preview #1.png>)", parser === "streaming");
    const preview = page.getByRole("button", { name: "Enlarge image: Preview" });
    await expect(preview).toBeVisible();
    await expect.poll(() => preview.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(512);
    expect(new URL(requests[0]).pathname).toBe(`/api/tasks/${taskId}/image`);
    expect(new URL(requests[0]).searchParams.get("path")).toBe("images/preview #1.png");
    await assertViewportLocked(page);
    if (parser === "static") await expect(page).toHaveScreenshot("image-preview-mobile.png");
    await preview.click();
    const dialog = page.getByRole("dialog", { name: "Preview", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("img")).toBeVisible();
    await assertViewportLocked(page);
    if (parser === "static") await expect(page).toHaveScreenshot("image-enlarged-mobile.png");
    await dialog.getByRole("button", { name: "Zoom in image" }).click();
    await expect.poll(() => imageTransform(page).then(value => value.scale)).toBeGreaterThan(1);
    await assertViewportLocked(page);
    await dialog.getByRole("button", { name: "Fit image" }).click();
    if (parser === "static") await page.evaluate(() => history.back());
    else await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(preview).toBeFocused();
    expect(errors).toEqual([]);
  });
}

test("remote, file URL, and embedded tool images render, while unsafe sources stay inert", async ({ page }) => {
  await page.route("https://images.example.invalid/**", route => route.fulfill({ contentType: "image/png", body: png }));
  await page.route("**/api/tasks/*/image?*", route => route.fulfill({ contentType: "image/png", body: png }));
  const taskId = await reply(page, "![Remote](https://images.example.invalid/preview.png) ![Local](file:///workspace/preview.png) ![Unsafe](javascript:alert%281%29)");
  for (const label of ["Remote", "Local"]) {
    await expect.poll(() => page.getByRole("img", { name: label, exact: true }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(512);
  }
  await expect(page.getByText("Image unavailable: Unsafe", { exact: true })).toBeVisible();
  await send(page, taskId, { type: "event", event: { taskId, agent: "codex", ts: 2, kind: "output_image",
    payload: { mediaType: "image/png", data: png.toString("base64") } } }, 2);
  const output = page.getByRole("button", { name: "Enlarge image: Session output" });
  await output.scrollIntoViewIfNeeded();
  await output.click();
  await expect(page.getByRole("dialog", { name: "Session output" })).toBeVisible();
});

test("failed images can be retried and linked images keep their destination", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/tasks/*/image?*", route => ++attempts === 1
    ? route.fulfill({ status: 404, body: "missing" }) : route.fulfill({ contentType: "image/png", body: png }));
  await reply(page, "![Generated preview](preview.png)\n\n[![Linked preview](linked.png)](https://example.invalid/details)");
  await expect(page.getByText("Image unavailable: Generated preview")).toBeVisible();
  await page.getByRole("button", { name: "Retry image" }).click();
  await expect.poll(() => page.getByRole("img", { name: "Generated preview" }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(512);
  const link = page.getByRole("link", { name: "Linked preview" });
  await expect(link).toHaveAttribute("href", "https://example.invalid/details");
  await expect(link.locator("button")).toHaveCount(0);
  await assertViewportLocked(page);
});

test.describe("image caching with the real service worker", () => {
  test.use({ serviceWorkers: "allow" });
  test("local previews never fall back to cached images while offline", async ({ page, context }) => {
  await page.goto("/");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  for (const path of ["/api/tasks/t-idle-rich/image?path=preview.png", "/api/tasks/t-idle-rich/attachments/93db3f15-c90f-40b4-a28c-b0fd573a6d9f"]) {
  await page.evaluate(async ({ path, data }) => {
    const cache = await caches.open("api");
    await cache.put(path, new Response(Uint8Array.from(atob(data), c => c.charCodeAt(0)), { headers: { "Content-Type": "image/png" } }));
  }, { path, data: png.toString("base64") });
  await context.setOffline(true);
  const result = await page.evaluate(async path => { try { return (await fetch(path)).status; } catch { return null; } }, path);
  expect(result).toBeNull();
  await context.setOffline(false);
  }
});
});


for (const viewport of [{ width: 360, height: 780 }, { width: 1280, height: 900 }]) {
  test(`sent attachments remain viewable after replay at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const taskId = "t-idle-rich", id = "93db3f15-c90f-40b4-a28c-b0fd573a6d9f";
    const path = `/api/tasks/${taskId}/attachments/${id}`;
    await page.route(`**${path}`, route => route.fulfill({ contentType: "image/png", body: png }));
    await installScopedStream(page);
    await open(page, taskId);
    const replay = async () => {
      await send(page, taskId, { type: "tasks", tasks: [], historyThrough: 0 });
      await send(page, taskId, { type: "event", event: { taskId, agent: "codex", ts: 1, kind: "status",
        payload: { subtype: "followup", text: "Please inspect this image", images: 1,
          attachments: [{ id, mediaType: "image/png", size: png.length }] } } }, 1);
    };
    await replay();
    const preview = page.getByRole("button", { name: "Enlarge image: Attached image 1" });
    await expect(preview).toBeVisible();
    await expect(preview.locator("img")).toHaveAttribute("src", path);
    await expect.poll(() => preview.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(512);
    await preview.click();
    await expect(page.getByRole("dialog", { name: "Attached image 1", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.reload();
    await expect.poll(() => page.evaluate(id => (window as unknown as { hasScopedStream(id: string): boolean }).hasScopedStream(id), taskId)).toBe(true);
    await replay();
    await expect(preview).toBeVisible();
    await expect.poll(() => preview.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(512);
    await assertViewportLocked(page);
  });
}

for (const width of [360, 1280]) {
  test(`expired attachments explain retention while missing images remain retryable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const expiredId = "93db3f15-c90f-40b4-a28c-b0fd573a6d9f";
    const missingId = "ad45ce67-5265-4b98-b601-8f80775ea7e2";
    let probes = 0;
    await page.route("**/api/tasks/*/attachments/*", route => {
      if (route.request().resourceType() === "fetch") probes++;
      return route.fulfill({ status: route.request().url().endsWith(expiredId) ? 410 : 404, body: "Unavailable" });
    });
    const taskId = await reply(page, "Images in this conversation");
    await send(page, taskId, { type: "event", event: { taskId, agent: "codex", kind: "status", ts: 2,
      payload: { subtype: "followup", text: "Saved images", attachments: [expiredId, missingId].map(id => ({ id, mediaType: "image/png", size: png.length })) } } }, 2);
    await expect(page.getByText("Image expired: Attached image 1", { exact: true })).toBeVisible();
    await expect(page.getByText("Image unavailable: Attached image 2", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry image", exact: true })).toHaveCount(1);
    await expect.poll(() => probes).toBe(2);
    await assertViewportLocked(page);
  });
}

async function imageTransform(page: Page) {
  return page.getByRole("dialog").getByRole("img").evaluate(img => {
    const matrix = new DOMMatrix(getComputedStyle(img.parentElement!).transform);
    return { scale: matrix.a, x: matrix.e, y: matrix.f };
  });
}

for (const viewport of [{ width: 360, height: 780 }, { width: 1280, height: 900 }]) {
  test(`image fullscreen fits, zooms, pans, and restores focus at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route("**/api/tasks/*/image?*", route => route.fulfill({ contentType: "image/png", body: png }));
    await reply(page, "![Preview](preview.png)");
    const trigger = page.getByRole("button", { name: "Enlarge image: Preview" });
    for (const theme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Preview", exact: true });
      await expect.poll(async () => {
        const box = (await dialog.boundingBox())!;
        return Object.fromEntries(Object.entries(box).map(([key, value]) => [key, Math.round(value)]));
      }).toEqual({ x: 0, y: 0, ...viewport });
      const canvas = dialog.getByRole("region", { name: "Preview", exact: true });
      await expect(canvas).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Zoom out image" })).toBeDisabled();
      await expect.poll(() => imageTransform(page)).toEqual({ scale: 1, x: 0, y: 0 });
      await canvas.focus();
      await page.keyboard.press("+");
      await expect.poll(async () => (await imageTransform(page)).scale).toBeGreaterThan(1);
      const zoomed = await imageTransform(page);
      const box = (await canvas.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2 - 40, { steps: 8 });
      await page.mouse.up();
      await expect.poll(async () => (await imageTransform(page)).x).toBeLessThan(zoomed.x - 20);
      await expect.poll(async () => (await imageTransform(page)).y).toBeLessThan(zoomed.y - 20);
      await dialog.getByRole("button", { name: "Fit image" }).click();
      await expect.poll(() => imageTransform(page)).toEqual({ scale: 1, x: 0, y: 0 });
      await captureForReview(page, `image-fullscreen-${viewport.width}-${theme}.png`);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await trigger.click();
      await expect.poll(() => imageTransform(page)).toEqual({ scale: 1, x: 0, y: 0 });
      await dialog.getByRole("button", { name: "Exit image fullscreen" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await assertViewportLocked(page);
    }
  });
}

test("native pinch and pan zoom only the fullscreen image", async ({ page, context }) => {
  await page.route("**/api/tasks/*/image?*", route => route.fulfill({ contentType: "image/png", body: png }));
  await reply(page, "![Preview](preview.png)");
  await page.getByRole("button", { name: "Enlarge image: Preview" }).click();
  const canvas = page.getByRole("region", { name: "Preview", exact: true });
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const cdp = await context.newCDPSession(page);
  const points = (radius: number) => [{ x: x - radius, y, id: 0 }, { x: x + radius, y, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(35) });
  for (let radius = 40; radius <= 90; radius += 10) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(radius) });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(async () => (await imageTransform(page)).scale).toBeGreaterThan(1.5);
  const pinched = await imageTransform(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 0 }] });
  for (let delta = 10; delta <= 50; delta += 10) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - delta, y: y - delta, id: 0 }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(async () => (await imageTransform(page)).x).toBeLessThan(pinched.x - 20);
  await expect.poll(async () => (await imageTransform(page)).y).toBeLessThan(pinched.y - 20);
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
  await page.getByRole("button", { name: "Fit image" }).click();
  await expect.poll(() => imageTransform(page)).toEqual({ scale: 1, x: 0, y: 0 });
  await cdp.detach();
});

test("inline images preserve transcript wheel and touch scrolling", async ({ page, context }) => {
  await page.route("**/api/tasks/*/image?*", route => route.fulfill({ contentType: "image/png", body: png }));
  await reply(page, Array.from({ length: 20 }, (_, i) => `Paragraph ${i}`).join("\n\n") + "\n\n![Preview](preview.png)");
  const trigger = page.getByRole("button", { name: "Enlarge image: Preview" });
  await trigger.scrollIntoViewIfNeeded();
  const transcript = page.locator('[data-radix-scroll-area-viewport][aria-label="Session transcript"]');
  const before = await transcript.evaluate(el => el.scrollTop);
  await trigger.hover();
  await page.mouse.wheel(0, -120);
  await expect.poll(() => transcript.evaluate(el => el.scrollTop)).toBeLessThan(before - 20);
  await trigger.scrollIntoViewIfNeeded();
  const beforeTouch = await transcript.evaluate(el => el.scrollTop);
  const box = (await trigger.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + 30;
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 0 }] });
  for (let delta = 20; delta <= 100; delta += 20) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + delta, id: 0 }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => transcript.evaluate(el => el.scrollTop)).toBeLessThan(beforeTouch - 20);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await cdp.detach();
  await assertViewportLocked(page);
});
