import { test, expect } from "@playwright/test";
import { installScopedStream, open, send } from "./_scoped-stream";
import { assertViewportLocked } from "./_helpers";

test.use({ serviceWorkers: "block" });
const file = { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Review this file") };

for (const route of ["new/space/repo-app", "task/t-idle-rich"]) test(`file-only messages preserve drafts after rejected sends: ${route}`, async ({ page }) => {
  await page.goto(`/#/${route}`);
  await page.getByRole("button", { name: "Add attachments" }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Files", exact: true }).click();
  await (await chooser).setFiles(file);
  await expect(page.getByRole("button", { name: "Remove file notes.txt", exact: true })).toBeVisible();
  const path = route.startsWith("new") ? "/api/tasks" : "/api/tasks/t-idle-rich/messages";
  await page.route(`**${path}`, route => route.fulfill({ status: 400, json: { error: "Try again" } }));
  const request = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === path);
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  const payload = (await request).postDataJSON();
  expect(payload.images).toEqual([{ mediaType: "application/octet-stream", data: file.buffer.toString("base64"), file: { name: file.name } }]);
  expect(payload.prompt ?? payload.text).toBe("See the attached file(s).");
  if (route.startsWith("new")) await page.getByRole("button", { name: "Edit message", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove file notes.txt", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove file notes.txt", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send now", exact: true })).toBeDisabled();
  await assertViewportLocked(page);
});

test("oversized files and too many files preserve the existing draft", async ({ page }) => {
  await page.goto("/#/task/t-idle-rich");
  const picker = page.getByLabel("Attach files", { exact: true });
  await picker.setInputFiles(file);
  await picker.setInputFiles({ name: "large.zip", mimeType: "application/zip", buffer: Buffer.alloc(20 * 1024 * 1024 + 1) });
  await expect(page.getByText("Files must be 20 MiB or smaller.")).toBeVisible();
  await picker.setInputFiles(Array.from({ length: 8 }, (_, i) => ({ ...file, name: `file-${i}.txt` })));
  await expect(page.getByText("Up to 8 attachments per message.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove file notes.txt", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Remove file/ })).toHaveCount(1);
});

for (const width of [360, 1280]) test(`stored file downloads survive transcript reload at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 780 });
  const taskId = "t-idle-rich", id = "93db3f15-c90f-40b4-a28c-b0fd573a6d9f";
  const name = "a-long-document-name-that-still-fits-on-a-phone.pdf";
  const path = `/api/tasks/${taskId}/attachments/${id}`;
  await page.route(`**${path}`, route => route.fulfill({ contentType: "application/octet-stream", headers: { "Content-Disposition": "attachment" }, body: file.buffer }));
  await installScopedStream(page); await open(page, taskId);
  const replay = async () => {
    await send(page, taskId, { type: "tasks", tasks: [], historyThrough: 0 });
    await send(page, taskId, { type: "event", event: { taskId, agent: "codex", ts: 1, kind: "status", payload: {
      subtype: "followup", text: "Review the file", attachments: [{ id, mediaType: "application/octet-stream", size: file.buffer.length, file: { name } }],
    } } }, 1);
  };
  for (const reload of [false, true]) {
    if (reload) {
      await page.reload();
      await expect.poll(() => page.evaluate(id => (window as unknown as { hasScopedStream(id: string): boolean }).hasScopedStream(id), taskId)).toBe(true);
    }
    await replay();
    const link = page.getByRole("link", { name: `Download ${name}`, exact: true });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("download", name);
    const download = page.waitForEvent("download");
    await link.click();
    expect((await download).suggestedFilename()).toBe(name);
    await assertViewportLocked(page);
  }
});
