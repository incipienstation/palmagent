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
  await expect(page.getByRole("button", { name: owner === "local" ? "Local shell" : "Continue in Palmagent" })).toBeVisible();
  await page.getByRole("button", { name: "Task actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeEnabled();
  await expect(page.getByRole("menuitem", { name: "Archive" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await assertViewportLocked(page);
});


test("a returned session requires a new release before showing its old shell command", async ({ page }) => {
  let owner = "palmagent";
  const current = () => ({ ...source, sessionControl: { owner, home: "/provider", transcript: "/provider/session.jsonl", cursor: 0, prefixHash: "fixture" } });
  await page.route("**/api/stream*", (route) => route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "tasks", tasks: [current()] })}\n\n` }));
  await page.route("**/api/tasks/t-idle-rich/handoff", (route) => {
    owner = "local";
    return route.fulfill({ json: { task: current(), command: "claude --resume sess-idle-0003" } });
  });
  await page.goto("/#/task/t-idle-rich");
  await page.getByRole("button", { name: "Resume in shell" }).click();
  await page.getByRole("button", { name: "Release to shell" }).click();
  await expect(page.getByRole("button", { name: "Copy resume command" })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByRole("button", { name: "Show resume command" })).toBeVisible();
  owner = "palmagent";
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByRole("button", { name: "Release to shell" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy resume command" })).toBeHidden();
});

test("live preview is readable before handoff and enables input only when ownership transfers", async ({ page }) => {
  let owner: "returning" | "palmagent" = "returning";
  const current = () => ({ ...source, sessionControl: { owner, home: "/provider", transcript: "/provider/session.jsonl", cursor: 42, prefixHash: "fixture" } });
  await page.route("**/api/stream*", (route) => route.fulfill({ contentType: "text/event-stream", body:
    `data: ${JSON.stringify({ type: "tasks", tasks: [current()] })}\n\n` +
    `id: 1\ndata: ${JSON.stringify({ type: "event", event: { taskId: source.taskId, agent: source.agent, kind: "assistant_text", ts: 0, payload: { text: "Saved locally and visible before closing the CLI." } } })}\n\n`,
  }));
  await page.goto("/");
  const local = page.locator("section").filter({ has: page.getByRole("heading", { name: "Local sessions", exact: true }) });
  await expect(local.getByText("Wire the web QA harness")).toBeVisible();
  await expect(local.getByText("Live preview", { exact: true })).toBeVisible();
  await page.goto("/#/task/t-idle-rich");
  await expect(page.getByText("Saved locally and visible before closing the CLI.", { exact: true })).toBeVisible();
  await expect(page.getByText("Done", { exact: true })).toBeHidden();
  await expect(page.getByPlaceholder("Read-only while controlled in your local CLI.")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Send now", exact: true })).toBeDisabled();
  await assertViewportLocked(page);
  await expect(page.getByRole("button", { name: "Task actions", exact: true })).toBeInViewport();
  await expect(page).toHaveScreenshot("session-live-preview.png");
  owner = "palmagent";
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByText("Live preview", { exact: true })).toBeHidden();
  await expect(page.getByPlaceholder("Send a follow-up turn… (paste images here)")).toBeEnabled();
  await expect(page.getByText("Saved locally and visible before closing the CLI.", { exact: true })).toHaveCount(1);
});

test("a preview synchronization error retains visible history and explains why input is paused", async ({ page }) => {
  const task = { ...source, sessionControl: { owner: "returning", home: "/provider", transcript: "/provider/session.jsonl", cursor: 42, prefixHash: "fixture", error: "Native transcript changed before the synchronization cursor" } };
  await page.route("**/api/stream*", (route) => route.fulfill({ contentType: "text/event-stream", body:
    `data: ${JSON.stringify({ type: "tasks", tasks: [task] })}\n\n` +
    `id: 1\ndata: ${JSON.stringify({ type: "event", event: { taskId: source.taskId, agent: source.agent, kind: "assistant_text", ts: 0, payload: { text: "Previously synchronized message" } } })}\n\n`,
  }));
  await page.goto("/#/task/t-idle-rich");
  await expect(page.getByText("Previously synchronized message", { exact: true })).toBeVisible();
  await expect(page.getByText("Sync issue", { exact: true })).toBeVisible();
  await expect(page.getByText(task.sessionControl.error, { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox")).toBeDisabled();
  await page.getByRole("button", { name: "Continue in Palmagent", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(task.sessionControl.error);
  await expect(page.getByRole("button", { name: "Release to shell" })).toBeHidden();
});
