import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.use({ serviceWorkers: "block", launchOptions: { args: ["--js-flags=--max-old-space-size=128"] } });

for (const route of ["new/space/repo-app", "task/t-idle-rich"]) test(`104 MiB binary upload survives cancellation and retry with a small heap: ${route}`, async ({ page }) => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "palmagent-upload-"));
  const path = join(directory, "large.bin"), size = 104 * 1024 * 1024;
  const file = await open(path, "w"); await file.truncate(size); await file.close();
  const uploads: { bytes: number; type: string; id: string }[] = [];
  const sink = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") { res.end(); return; }
    let bytes = 0, prefix = "";
    req.on("data", chunk => {
      bytes += chunk.length;
      if (prefix.length < 16_384) prefix += chunk.subarray(0, 16_384 - prefix.length).toString("utf8");
    });
    req.on("end", () => {
      const metadata = JSON.parse(prefix.split("\r\n\r\n")[1].split("\r\n")[0]);
      uploads.push({ bytes, type: String(req.headers["content-type"]), id: metadata.clientRequestId ?? metadata.clientMessageId });
      // First request waits for explicit cancellation, the retry gets a receipt.
      if (uploads.length > 1) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "Keep this draft" })); }
    });
  });
  await new Promise<void>(resolve => sink.listen(0, "localhost", resolve));
  const endpoint = `http://localhost:${(sink.address() as { port: number }).port}`;
  try {
    await page.addInitScript(endpoint => {
      const nativeFetch = window.fetch;
      window.fetch = (url, init) => {
        if (init?.body instanceof FormData && String(url).includes("/api/tasks")) {
          return nativeFetch(endpoint, { method: "POST", body: init.body, signal: init.signal });
        }
        return nativeFetch(url, init);
      };
    }, endpoint);
    await page.goto(`/#/${route}`);
    await page.getByLabel("Attach files", { exact: true }).setInputFiles(path);
    await expect(page.getByRole("button", { name: "Remove file large.bin", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Send now", exact: true }).click();
    await expect.poll(() => uploads.length).toBe(1);
    expect(uploads[0].type).toMatch(/^multipart\/form-data; boundary=/);
    expect(uploads[0].bytes).toBeGreaterThan(size);
    expect(uploads[0].bytes).toBeLessThan(size + 16_384);
    await page.getByRole("button", { name: "Stop sending", exact: true }).click();
    if (route.startsWith("new")) {
      // Reload resolves to unknown, retaining the binary file and original ID.
      await page.reload();
      await page.getByRole("button", { name: "Retry", exact: true }).click();
    } else {
      await expect(page.getByRole("button", { name: "Remove file large.bin", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Send now", exact: true }).click();
    }
    await expect.poll(() => uploads.length).toBe(2);
    expect(uploads[1].bytes).toBe(uploads[0].bytes);
    expect(uploads[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(uploads[1].id).toBe(uploads[0].id);
    await expect(page.getByText("Keep this draft", { exact: true })).toBeVisible();
  } finally {
    sink.closeAllConnections(); await new Promise<void>(resolve => sink.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
