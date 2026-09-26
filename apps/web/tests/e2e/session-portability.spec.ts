import { test, expect } from "@playwright/test";
import { tasks } from "../fixtures.mjs";
import { assertViewportLocked, openSessionDetails } from "./_helpers";

// Route-based session fixtures must not be bypassed by the installed SW.
test.use({ serviceWorkers: "block" });

const source = tasks.find((t) => t.taskId === "t-idle-rich")!;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=";

async function installHistory(page: import("@playwright/test").Page, kind: string, payload: unknown) {
  await page.route("**/api/tasks/t-idle-rich/history*", (route) => route.fulfill({ json: {
    events: [{ seq: 1, event: { taskId: source.taskId, agent: source.agent, ts: 0, kind, payload } }],
    before: null,
    cursor: 1,
  } }));
}

test("mobile directory selection filters tasks and survives reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Wire the web QA harness")).toBeVisible();
  await page.getByRole("button", { name: /^Switch space:/ }).click();
  await page.getByRole("button", { name: /^Worktrees/ }).click();
  await page.getByRole("button", { name: /t-idle-rich/ }).click();
  await expect(page.getByText("Wire the web QA harness")).toBeVisible();
  await expect(page.getByText("Interrupted across a deploy")).toBeHidden();
  await assertViewportLocked(page);
  await page.reload();
  await expect(page.getByText("Wire the web QA harness")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Switch space:/ })).toContainText("t-idle-rich");
  await page.getByRole("button", { name: /^Switch space:/ }).click();
  await page.getByRole("button", { name: /All spaces/ }).click();
  await expect(page.getByText("Interrupted across a deploy")).toBeVisible();
});

test("desktop directory navigation identifies each cwd without overflowing", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Spaces" });
  await expect(nav).toBeVisible();
  await nav.getByRole("button", { name: /^Worktrees/ }).click();
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
  await openSessionDetails(page);
  await expect(page.getByRole("heading", { name: "Resume in your shell" })).toBeVisible();
  expect(releases).toBe(0);
  await page.getByRole("button", { name: "Release to shell" }).click();
  await expect(page.locator("code").filter({ hasText: command })).toBeVisible();
  expect(releases).toBe(1);
  await expect(page.getByRole("button", { name: "Copy resume command" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Copy resume command" })).toBeInViewport();
  await assertViewportLocked(page);
  await expect(page).toHaveScreenshot("session-handoff.png");
});

for (const owner of ["local", "returning"] as const) test(`${owner} ownership disables follow-up and archive while structured image outputs render`, async ({ page }) => {
  await installHistory(page, "output_image", { mediaType: "image/png", data: png });
  await page.route("**/api/stream*", (route) => route.fulfill({ contentType: "text/event-stream", body:
    `data: ${JSON.stringify({ type: "tasks", tasks: [{ ...source, sessionControl: { owner, home: "/provider", transcript: "/provider/session.jsonl", cursor: 0, prefixHash: "fixture" } }] })}\n\n`,
  }));
  await page.goto("/#/task/t-idle-rich");
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByRole("img", { name: "Session output" })).toBeVisible();
  await expect.poll(() => page.getByRole("img", { name: "Session output" }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  await openSessionDetails(page);
  const details = page.getByRole("dialog", { name: "Session details" });
  await expect(details.getByText(owner === "local" ? "Local shell" : "Live preview", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
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
  await openSessionDetails(page);
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
  await installHistory(page, "assistant_text", { text: "Saved locally and visible before closing the CLI." });
  await page.route("**/api/stream*", (route) => route.fulfill({ contentType: "text/event-stream", body:
    `data: ${JSON.stringify({ type: "tasks", tasks: [current()] })}\n\n`,
  }));
  await page.goto("/");
  const local = page.locator("section").filter({ has: page.getByRole("heading", { name: "Local sessions", exact: true }) });
  await expect(local.getByText("Wire the web QA harness")).toBeVisible();
  await expect(local.getByText("Live preview", { exact: true })).toBeVisible();
  await page.goto("/#/task/t-idle-rich");
  await expect(page.getByText("Saved locally and visible before closing the CLI.", { exact: true })).toBeVisible();
  await expect(page.getByText("Done", { exact: true })).toBeHidden();
  await expect(page.getByRole("group", { name: "Message composer", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send now", exact: true })).toHaveCount(0);

  await assertViewportLocked(page);
  await expect(page.getByRole("button", { name: "Task actions", exact: true })).toBeInViewport();
  await expect(page).toHaveScreenshot("session-live-preview.png");
  owner = "palmagent";
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByText("Live preview", { exact: true })).toBeHidden();
  await expect(page.getByPlaceholder("Send a follow-up turn…")).toBeEnabled();
  await expect(page.getByText("Saved locally and visible before closing the CLI.", { exact: true })).toHaveCount(1);
});

test("a preview synchronization error retains visible history and explains why input is paused", async ({ page }) => {
  const task = { ...source, sessionControl: { owner: "returning", home: "/provider", transcript: "/provider/session.jsonl", cursor: 42, prefixHash: "fixture", error: "Native transcript changed before the synchronization cursor" } };
  await installHistory(page, "assistant_text", { text: "Previously synchronized message" });
  await page.route("**/api/stream*", (route) => route.fulfill({ contentType: "text/event-stream", body:
    `data: ${JSON.stringify({ type: "tasks", tasks: [task] })}\n\n`,
  }));
  await page.goto("/#/task/t-idle-rich");
  await expect(page.getByText("Previously synchronized message", { exact: true })).toBeVisible();
  await expect(page.getByText(task.sessionControl.error, { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await openSessionDetails(page);
  const details = page.getByRole("dialog", { name: "Session details" });
  await expect(details.getByText("Sync issue", { exact: true })).toBeVisible();
  await expect(details).toContainText(task.sessionControl.error);
  await expect(details.getByRole("button", { name: "Release to shell" })).toBeHidden();
});
