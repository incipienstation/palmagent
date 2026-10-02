import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { installScopedStream, open, send } from "./_scoped-stream";
import { assertViewportLocked } from "./_helpers";

test.use({ serviceWorkers: "block" });
const fixture = new URL("../fixtures/blue-video.webm", import.meta.url);
const bytes = readFileSync(fixture);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

for (const route of ["new", "task/t-idle-rich"]) test(`video-only preparation, playback, and failed-send recovery: ${route}`, async ({ page }) => {
  await page.goto(`/#/${route === "new" ? "new/space/repo-app" : route}`);
  await page.getByRole("button", { name: "Add attachments" }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Videos", exact: true }).click();
  await (await chooser).setFiles(fileURLToPath(fixture));
  const preview = page.getByRole("button", { name: "Play video: attachment 1", exact: true });
  await expect(preview).toBeVisible();
  await expect(page.getByText("Agents receive sampled frames. Audio is not included.")).toBeVisible();
  await preview.click();
  const player = page.getByRole("dialog").locator("video");
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
  expect(await player.evaluate((video: HTMLVideoElement) => [video.duration, video.videoWidth, video.videoHeight])).toEqual([4, 32, 24]);
  await player.evaluate((video: HTMLVideoElement) => { video.currentTime = 2; });
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.currentTime)).toBe(2);
  await page.keyboard.press("Escape");
  const path = route === "new" ? "/api/tasks" : "/api/tasks/t-idle-rich/messages";
  await page.route(`**${path}`, route => route.fulfill({ status: 400, json: { error: "Try again" } }));
  const request = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === path);
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  const payload = (await request).postDataJSON();
  expect(payload.images).toHaveLength(1);
  expect(payload.images[0].mediaType).toBe("video/webm");
  expect(Buffer.from(payload.images[0].data, "base64")).toEqual(bytes);
  expect(payload.images[0].video.frames).toHaveLength(2);
  expect(payload.images[0].video.frames.map((frame: { timestamp: number }) => frame.timestamp)).toEqual([0, 3.9]);
  expect(payload.images[0].video.frames.every((frame: { image: { mediaType: string } }) => frame.image.mediaType === "image/jpeg")).toBe(true);
  if (route === "new") await page.getByRole("button", { name: "Edit message", exact: true }).click();
  await expect(preview).toBeVisible();
  await page.getByRole("button", { name: "Remove video 1", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send now", exact: true })).toBeDisabled();
  await assertViewportLocked(page);
});

test("invalid and oversized videos preserve existing image attachments", async ({ page }) => {
  await page.goto("/#/task/t-idle-rich");
  await page.getByLabel("Attach photos", { exact: true }).setInputFiles({ name: "image.png", mimeType: "image/png", buffer: png });
  await expect(page.getByAltText("attachment 1")).toBeVisible();
  await page.getByLabel("Attach videos", { exact: true }).setInputFiles({ name: "invalid.webm", mimeType: "video/webm", buffer: png });
  await expect(page.getByText(/This video cannot be decoded/)).toBeVisible();
  await page.getByLabel("Attach videos", { exact: true }).setInputFiles({ name: "large.webm", mimeType: "video/webm", buffer: Buffer.alloc(20 * 1024 * 1024 + 1) });
  await expect(page.getByText(/Videos must be 20 MiB or smaller/)).toBeVisible();
  await expect(page.getByAltText("attachment 1")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send now", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: /Play video/ })).toHaveCount(0);
});

for (const width of [360, 1280]) test(`stored videos play after transcript replay and reload at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 780 });
  const taskId = "t-idle-rich", id = "93db3f15-c90f-40b4-a28c-b0fd573a6d9f", frameId = "ab83e047-bf84-4266-93b8-b4618e7a81c4";
  const path = `/api/tasks/${taskId}/attachments/${id}`;
  await page.route(`**${path}`, route => route.fulfill({ contentType: "video/webm", body: bytes }));
  await page.route(`**/attachments/${frameId}`, route => route.fulfill({ contentType: "image/png", body: png }));
  await installScopedStream(page); await open(page, taskId);
  const replay = async () => {
    await send(page, taskId, { type: "tasks", tasks: [], historyThrough: 0 });
    await send(page, taskId, { type: "event", event: { taskId, agent: "codex", ts: 1, kind: "status", payload: {
      subtype: "followup", text: "Review the recording", attachments: [{ id, mediaType: "video/webm", size: bytes.length,
        video: { duration: 4, frames: [{ id: frameId, mediaType: "image/png", size: png.length, timestamp: 0 }] } }],
    } } }, 1);
  };
  for (const reload of [false, true]) {
    if (reload) {
      await page.reload();
      await expect.poll(() => page.evaluate(id => (window as unknown as { hasScopedStream(id: string): boolean }).hasScopedStream(id), taskId)).toBe(true);
    }
    await replay();
    await page.getByRole("button", { name: "Play video: Attached video 1", exact: true }).click();
    const player = page.getByRole("dialog").locator("video");
    await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
    await expect(player).toHaveAttribute("src", path);
    await player.evaluate((video: HTMLVideoElement) => video.play());
    await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await assertViewportLocked(page);
  }
});


for (const extension of ["mp4", "mov"]) test(`${extension.toUpperCase()} videos prepare browser-decodable sampled frames`, async ({ page }) => {
  await page.goto("/#/task/t-idle-rich");
  await page.getByLabel("Attach videos", { exact: true }).setInputFiles(fileURLToPath(new URL(`../fixtures/blue-video.${extension}`, import.meta.url)));
  const preview = page.getByRole("button", { name: "Play video: attachment 1", exact: true });
  await expect(preview).toBeVisible();
  const pixels = await preview.locator("img").evaluate(async (image: HTMLImageElement) => {
    await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
    return [...context.getImageData(16, 12, 1, 1).data];
  });
  expect(pixels[2]).toBeGreaterThan(200); expect(pixels[0]).toBeLessThan(20);
  await preview.click();
  const player = page.getByRole("dialog").locator("video");
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.duration)).toBe(4);
});
