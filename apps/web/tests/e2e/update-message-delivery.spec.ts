import { test, expect } from "@playwright/test";
import { tasks } from "../fixtures.mjs";
import { installScopedStream, open, send } from "./_scoped-stream";
import { assertViewportLocked, captureForReview } from "./_helpers";

test.use({ serviceWorkers: "block" });
const message = { clientMessageId: "", text: "", mode: "send", expectedRunId: "run-1" };

test("a send waits through maintenance and reconnects with the same message, then clears its waiting control", async ({ page }) => {
  await installScopedStream(page);
  let available = false;
  const requests: typeof message[] = [];
  await page.route("**/api/tasks/t-run/messages", route => {
    requests.push(route.request().postDataJSON());
    expect(route.request().headers()["x-palmagent-message-protocol"]).toBe("1");
    return available ? route.fulfill({ json: { revision: 2, paused: false, runId: "run-1", messages: [] } })
      : route.fulfill({ status: 503, json: { error: "Updating", code: "update_in_progress" } });
  });
  await open(page, "t-run");
  await send(page, "t-run", { type: "tasks", tasks: [{ ...tasks.find(t => t.taskId === "t-run")!, messageQueue: { revision: 1, paused: false, runId: "run-1", messages: [] } }], historyThrough: 0 });
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Continue after update");
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  await expect(page.getByText("Waiting for update…", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop retrying", exact: true })).toBeEnabled();
  await expect(page.getByRole("group", { name: "Your message" }).filter({ hasText: "Continue after update" })).toHaveCount(1);
  await expect(page.getByTestId("toast")).toHaveCount(0);
  await assertViewportLocked(page);
  await captureForReview(page, "update-message-waiting.png");
  available = true;
  await expect.poll(() => requests.length).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole("button", { name: "Stop retrying", exact: true })).toHaveCount(0);
  expect(new Set(requests.map(request => JSON.stringify(request))).size).toBe(1);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("");
  await expect(page.getByTestId("toast")).toHaveCount(0);
});

test("stopping automatic retries restores the draft and an explicit resend keeps its request ID", async ({ page }) => {
  await installScopedStream(page);
  let releaseRecovery!: () => void;
  const recovery = new Promise<void>(resolve => { releaseRecovery = resolve; });
  await page.route("**/api/tasks/t-run", async route => {
    await recovery;
    await route.fulfill({ json: { task: tasks.find(task => task.taskId === "t-run") } });
  });
  let available = false;
  const requests: typeof message[] = [];
  await page.route("**/api/tasks/t-run/messages", route => {
    requests.push(route.request().postDataJSON());
    return available ? route.fulfill({ json: { revision: 2, paused: false, runId: "run-1", messages: [] } })
      : route.fulfill({ status: 503, json: { error: "Updating", code: "update_in_progress" } });
  });
  await open(page, "t-run");
  await send(page, "t-run", { type: "tasks", tasks: [{ ...tasks.find(t => t.taskId === "t-run")!, messageQueue: { revision: 1, paused: false, runId: "run-1", messages: [] } }], historyThrough: 0 });
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Keep my draft");
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  await page.getByRole("button", { name: "Stop retrying", exact: true }).click();
  await expect(input).toHaveValue("Keep my draft");
  await expect(input).toBeEnabled();
  const stoppedAt = requests.length;
  await page.waitForTimeout(1200);
  expect(requests.length).toBe(stoppedAt);
  available = true;
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect.poll(() => requests.length).toBe(stoppedAt + 1);
  expect(new Set(requests.map(request => request.clientMessageId)).size).toBe(1);
  releaseRecovery();
});

test("a first message and its attachment survive an update wait without creating a second conversation", async ({ page }) => {
  await installScopedStream(page);
  let available = false;
  const bodies: string[] = [];
  const task = { ...tasks.find(t => t.taskId === "t-run")!, prompt: "First message after update" };
  await page.route("**/api/tasks", route => {
    if (route.request().method() !== "POST") return route.continue();
    bodies.push(route.request().postData()!);
    return available ? route.fulfill({ status: 201, json: { task } })
      : route.fulfill({ status: 503, json: { error: "Updating", code: "update_in_progress" } });
  });
  await page.goto("/#/new/space/repo-app");
  await page.getByLabel("Prompt", { exact: true }).fill(task.prompt);
  await page.getByLabel("Attach photos", { exact: true }).setInputFiles({ name: "image.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64") });
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  await expect(page.getByText("Waiting for update…", { exact: true })).toBeVisible();
  await expect(page.getByAltText("Attached image 1", { exact: true })).toBeVisible();
  await expect(page.getByText("Working…", { exact: true })).toHaveCount(0);
  available = true;
  await expect(page).toHaveURL(/task\/t-run$/);
  expect(bodies.length).toBeGreaterThanOrEqual(2);
  expect(new Set(bodies).size).toBe(1);
  expect(JSON.parse(bodies[0]).images).toHaveLength(1);
  await expect(page.getByTestId("toast")).toHaveCount(0);
});

test("a slow attachment send can be stopped before any retry and restores its draft", async ({ page }) => {
  await installScopedStream(page);
  let calls = 0;
  await page.route("**/api/tasks/t-idle-rich/messages", () => { calls++; });
  await open(page, "t-idle-rich");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Keep this archive");
  await page.getByLabel("Attach files", { exact: true }).setInputFiles({
    name: "archive.zip", mimeType: "application/zip", buffer: Buffer.from("fixture"),
  });
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  await expect(page.getByText("Sending attachments…", { exact: true })).toBeVisible();
  await expect.poll(() => calls).toBe(1);
  await page.getByRole("button", { name: "Stop sending", exact: true }).click();
  await expect(input).toHaveValue("Keep this archive");
  await expect(input).toBeEnabled();
  await expect(page.getByRole("button", { name: "Remove file archive.zip", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop sending", exact: true })).toHaveCount(0);
  await page.waitForTimeout(1200);
  expect(calls).toBe(1);
});
