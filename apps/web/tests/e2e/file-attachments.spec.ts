import { INPUT_FILE_POLICY } from "@palmagent/shared";
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
  const sent = await request;
  const body = await new Response(new Uint8Array(sent.postDataBuffer()!), { headers: { "content-type": sent.headers()["content-type"] } }).formData();
  const payload = JSON.parse(body.get("request") as string);
  expect(payload.images).toEqual([{ mediaType: "application/octet-stream", data: "", binary: true, file: { name: file.name } }]);
  expect(Buffer.from(await (body.get("attachment-0") as File).arrayBuffer())).toEqual(file.buffer);
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
  // Exercise size rejection without copying a 256 MiB fixture through Playwright.
  await picker.evaluate((element, size) => {
    const file = new File(["oversized"], "large.zip", { type: "application/zip" });
    Object.defineProperty(file, "size", { value: size });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    (element as HTMLInputElement).files = transfer.files;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, INPUT_FILE_POLICY.maxBytes + 1);
  await expect(page.getByText("Files must be 256 MiB or smaller.")).toBeVisible();
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


test("new-chat storage failure keeps the file editable and never starts an upload", async ({ page }) => {
  await page.addInitScript(() => { indexedDB.open = () => { throw new DOMException("Storage unavailable", "QuotaExceededError"); }; });
  let uploads = 0;
  await page.route("**/api/tasks", route => {
    if (route.request().method() === "POST") uploads++;
    return route.continue();
  });
  await page.goto("/#/new/space/repo-app");
  await page.getByLabel("Attach files", { exact: true }).setInputFiles(file);
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  await expect(page.getByText("Could not preserve the attached file.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Edit message", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove file notes.txt", exact: true })).toBeVisible();
  expect(uploads).toBe(0);
});
