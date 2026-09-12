import { test, expect } from "@playwright/test";
import { tasks } from "../fixtures.mjs";
import { assertViewportLocked } from "./_helpers";

// Route-based session fixtures must not be bypassed by the installed SW.
test.use({ serviceWorkers: "block" });

const source = tasks.find((t) => t.taskId === "t-idle-rich")!;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=";

test("mobile directory selection filters tasks and survives reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Wire the web QA harness")).toBeVisible();
  await page.getByRole("combobox", { name: "Working directory" }).click();
  await page.getByRole("option", { name: /t-idle-rich/ }).click();
  await expect(page.getByText("Wire the web QA harness")).toBeVisible();
  await expect(page.getByText("Interrupted across a deploy")).toBeHidden();
  await assertViewportLocked(page);
  await page.reload();
  await expect(page.getByText("Wire the web QA harness")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Working directory" })).toContainText("t-idle-rich");
  await page.getByRole("combobox", { name: "Working directory" }).click();
  await page.getByRole("option", { name: /All directories/ }).click();
  await expect(page.getByText("Interrupted across a deploy")).toBeVisible();
});

test("desktop directory navigation identifies each cwd without overflowing", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Working directories" });
  await expect(nav).toBeVisible();
  await nav.getByRole("button", { name: /t-idle-rich/ }).click();
  await expect(page.getByText("Wire the web QA harness")).toBeVisible();
  await expect(page.getByText("Interrupted across a deploy")).toBeHidden();
  await assertViewportLocked(page);
  await expect(page).toHaveScreenshot("working-directories-desktop.png");
});

test("handoff only releases on explicit action and offers a selectable native command", async ({ page }) => {
  let releases = 0;
  const command = "cd '/projects/sample-app' && 'claude' '--resume' 'sess-idle-0003'";
  await page.route("**/api/tasks/t-idle-rich/handoff", (route) => {
    releases++;
    return route.fulfill({ json: { task: source, command } });
  });
  await page.goto("/#/task/t-idle-rich");
  await page.getByRole("button", { name: "Resume in shell" }).click();
  await expect(page.getByRole("heading", { name: "Resume in your shell" })).toBeVisible();
  expect(releases).toBe(0);
  await page.getByRole("button", { name: "Release to shell" }).click();
  await expect(page.locator("code").filter({ hasText: command })).toBeVisible();
  expect(releases).toBe(1);
  await expect(page.getByRole("button", { name: "Copy resume command" })).toBeEnabled();
  await assertViewportLocked(page);
  await expect(page).toHaveScreenshot("session-handoff.png");
});

for (const owner of ["local", "returning"] as const) test(`${owner} ownership disables follow-up and archive while structured image outputs render`, async ({ page }) => {
  await page.route("**/api/stream*", (route) => route.fulfill({ contentType: "text/event-stream", body:
    `data: ${JSON.stringify({ type: "tasks", tasks: [{ ...source, sessionControl: { owner, home: "/provider", transcript: "/provider/session.jsonl", cursor: 0, prefixHash: "fixture" } }] })}\n\n` +
    `id: 1\ndata: ${JSON.stringify({ type: "event", event: { taskId: source.taskId, agent: source.agent, kind: "output_image", ts: 0, payload: { mediaType: "image/png", data: png } } })}\n\n`,
  }));
  await page.goto("/#/task/t-idle-rich");
  await expect(page.getByRole("textbox")).toBeDisabled();
  await expect(page.getByRole("img", { name: "Session output" })).toBeVisible();
  await expect.poll(() => page.getByRole("img", { name: "Session output" }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  await expect(page.getByRole("button", { name: owner === "local" ? "Local shell" : "Returning from shell" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Task actions" })).toBeDisabled();
  await assertViewportLocked(page);
});
