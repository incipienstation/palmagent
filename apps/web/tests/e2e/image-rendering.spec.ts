import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { assertViewportLocked } from "./_helpers";
import { installScopedStream, open, send } from "./_scoped-stream";

test.use({ serviceWorkers: "block" });

const png = readFileSync(new URL("../../public/icon-512.png", import.meta.url));
async function reply(page: Page, text: string, running = false) {
  await installScopedStream(page);
  await open(page, running ? "t-run-charts" : "t-idle-rich");
  const taskId = running ? "t-run-charts" : "t-idle-rich";
  await send(page, taskId, { type: "tasks", tasks: [], replayThrough: 0 });
  await send(page, taskId, { type: "event", event: {
    taskId, agent: "codex", ts: 1, kind: "assistant_text", payload: { text, phase: "final", messageId: "image-reply" },
  } }, 1);
  return taskId;
}

for (const parser of ["static", "streaming", "long"] as const) {
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
    await dialog.getByRole("button", { name: "Actual size" }).click();
    await expect.poll(() => dialog.getByRole("img").evaluate(img => img.getBoundingClientRect().width)).toBe(512);
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
      await send(page, taskId, { type: "tasks", tasks: [], replayThrough: 0 });
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
