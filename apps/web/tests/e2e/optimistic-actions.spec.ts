import { test, expect, type Page } from "@playwright/test";
import type { MessageQueue, PendingMessage, UpdateSettingsStatus, RepoSettingsStatus } from "@palmagent/shared";
import { tasks, routines, repos, updateSettings } from "../fixtures.mjs";
import { installScopedStream, open, send } from "./_scoped-stream";
import { assertViewportLocked } from "./_helpers";

test.use({ serviceWorkers: "block" });
function gate() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); return { wait, release }; }
async function settings(page: Page, section?: "Updates" | "Repository search paths") {
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  if (section) await page.getByRole("button", { name: section, exact: true }).click();
}
async function queueSetup(page: Page, messages: PendingMessage[] = []) {
  await installScopedStream(page);
  const task = { ...tasks.find(t => t.taskId === "t-run")!, messageQueue: { revision: 1, runId: "run-1", paused: false, messages } as MessageQueue };
  await page.route("**/api/tasks/t-run", route => route.fulfill({ json: { task } }));
  await open(page, "t-run");
  await send(page, "t-run", { type: "tasks", tasks: [task], historyThrough: 0 });
  return task;
}
async function queueMenu(page: Page, text: string) {
  await page.getByRole("button", { name: new RegExp(`Queued message .*${text}`) }).click({ button: "right" });
}
const message: PendingMessage = { id: "11111111-1111-4111-8111-111111111111", version: 1, mode: "queue", text: "Queued original", status: "queued" };

test("update preferences coalesce rapid input and serialize changes made during a request", async ({ page }) => {
  const state = structuredClone(updateSettings) as UpdateSettingsStatus;
  const delayed = gate(); const calls: any[] = [];
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.route("**/api/settings/updates", async route => {
    if (route.request().method() === "PATCH") {
      const change = route.request().postDataJSON(); calls.push(change);
      if (calls.length === 1) await delayed.wait;
      Object.assign(state.settings!, change);
    }
    await route.fulfill({ json: state });
  });
  await page.goto("/"); await settings(page, "Updates");
  await page.clock.pauseAt(new Date("2026-01-01T00:01:00Z"));
  const control = page.getByRole("switch", { name: "Automatic updates" });
  await control.click(); await control.click(); await control.click();
  await expect(control).toBeChecked(); expect(calls).toHaveLength(0);
  await page.clock.runFor(251); await expect.poll(() => calls.length).toBe(1);
  await control.click();
  await expect(control).not.toBeChecked();
  await page.getByRole("radio", { name: "Stable", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Stable", exact: true })).toBeChecked();
  await page.clock.runFor(251); expect(calls).toHaveLength(1);
  delayed.release();
  await expect.poll(() => calls).toEqual([{ autoUpdate: true }, { autoUpdate: false }, { channel: "stable" }]);
  await expect(control).not.toBeChecked();
  await expect(page.getByText("Saving…", { exact: true })).toBeHidden();
});

test("a pending preference survives closing Settings and rolls back with a toast", async ({ page }) => {
  const delayed = gate(); let writes = 0;
  await page.route("**/api/settings/updates", async route => {
    if (route.request().method() === "PATCH") { writes++; await delayed.wait; return route.fulfill({ status: 503, json: { error: "Preference could not be saved" } }); }
    await route.fulfill({ json: updateSettings });
  });
  await page.goto("/"); await settings(page, "Updates");
  const control = page.getByRole("switch", { name: "Automatic updates" });
  await control.click(); await expect(control).toBeChecked();
  await page.getByRole("button", { name: "Close settings" }).click();
  await settings(page);
  await expect(control).toBeChecked(); await expect(control).toBeEnabled();
  await expect.poll(() => writes).toBe(1); delayed.release();
  await expect(control).not.toBeChecked();
  await expect(page.getByTestId("toast")).toContainText("Preference could not be saved");
});

for (const action of ["remove", "reset"] as const) test(`search path ${action} changes immediately and restores the confirmed paths on failure`, async ({ page }) => {
  const state: RepoSettingsStatus = { repoRoots: ["/projects/custom"], defaults: ["/projects/default"], source: "saved", writable: true };
  const delayed = gate(); let writes = 0;
  await page.route("**/api/settings/repos", async route => {
    if (route.request().method() === "PATCH") { writes++; await delayed.wait; return route.fulfill({ status: 503, json: { error: "Paths unavailable" } }); }
    await route.fulfill({ json: state });
  });
  await page.goto("/"); await settings(page, "Repository search paths");
  const region = page.getByRole("region", { name: "Repository search paths" });
  await region.getByRole("button", { name: action === "remove" ? "Remove /projects/custom" : "Use installation defaults", exact: true }).click();
  await expect(region.getByText("/projects/custom", { exact: true })).toBeHidden();
  if (action === "reset") await expect(region.getByText("/projects/default", { exact: true })).toBeVisible();
  expect(writes).toBe(1); delayed.release();
  await expect(region.getByText("/projects/custom", { exact: true })).toBeVisible();
  await expect(page.getByTestId("toast")).toContainText("Couldn't save search paths");
});

test("new search paths remain pending until validated and retain the draft on rejection", async ({ page }) => {
  const delayed = gate();
  await page.route("**/api/settings/repos", async route => {
    if (route.request().method() === "PATCH") { await delayed.wait; return route.fulfill({ status: 400, json: { error: "Folder is inaccessible" } }); }
    await route.fulfill({ json: { repoRoots: [], defaults: [], source: "saved", writable: true } });
  });
  await page.goto("/"); await settings(page, "Repository search paths");
  await page.getByRole("textbox", { name: "Add search folder" }).fill("~/new-folder");
  await page.getByRole("button", { name: "Add folder", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "~/new-folder · Adding…" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove ~/new-folder" })).toHaveCount(0);
  await page.getByRole("button", { name: "Close settings" }).click();
  await settings(page);
  delayed.release();
  await expect(page.getByRole("textbox", { name: "Add search folder" })).toHaveValue("~/new-folder");
  await expect(page.getByTestId("toast")).toContainText("Folder is inaccessible");
});

test("routine switches are independent, debounce repeated clicks, and recover a failed toggle", async ({ page }) => {
  const delayed = gate(); const calls: boolean[] = [];
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.route("**/api/routines/r-standup", async route => { calls.push(route.request().postDataJSON().enabled); await delayed.wait; await route.fulfill({ status: 503, json: { error: "Schedule unavailable" } }); });
  await page.goto("/#/routines");
  const switches = page.getByRole("switch", { name: "Enabled" });
  await expect(switches.first()).toBeChecked();
  await page.clock.pauseAt(new Date("2026-01-01T00:01:00Z"));
  await switches.first().click(); await switches.first().click(); await switches.first().click();
  await expect(switches.first()).not.toBeChecked();
  await expect(switches.nth(1)).toBeEnabled(); expect(calls).toEqual([]);
  await page.clock.runFor(251); await expect.poll(() => calls).toEqual([false]);
  delayed.release(); await expect(switches.first()).toBeChecked();
  await page.clock.runFor(300);
  await expect(page.getByTestId("toast")).toContainText("Schedule unavailable");
});

for (const action of ["run", "delete"] as const) test(`routine ${action} gives immediate feedback, blocks duplicates, and restores on failure`, async ({ page }) => {
  const delayed = gate(); let calls = 0;
  await page.route(`**/api/routines/r-standup${action === "run" ? "/run" : ""}`, async route => { calls++; await delayed.wait; await route.fulfill({ status: 503, json: { error: "Routine action failed" } }); });
  await page.goto("/#/routines");
  const card = page.locator('[data-slot="card"]').filter({ hasText: "Morning standup digest" });
  if (action === "run") {
    await card.getByRole("button", { name: "Run now", exact: true }).click();
    await expect(card.getByRole("button", { name: "Requesting run…" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Run now", exact: true }).first()).toBeEnabled();
  } else {
    await card.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: /Delete/ }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete routine", exact: true }).click();
    await expect(card).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: "Deleting routine…" })).toBeVisible();
  }
  expect(calls).toBe(1); delayed.release();
  await expect(card).toBeVisible();
  await expect(page.getByTestId("toast")).toContainText("Routine action failed");
});

test("creating a routine shows a pending card and preserves its draft on failure", async ({ page }) => {
  const delayed = gate(); let calls = 0;
  await page.route("**/api/routines", async route => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { routines } });
    calls++; await delayed.wait; await route.fulfill({ status: 400, json: { error: "Invalid schedule" } });
  });
  await page.goto("/#/routines"); await page.getByRole("button", { name: "New routine", exact: true }).click();
  await page.locator("form textarea").fill("A new scheduled task");
  await page.getByRole("button", { name: "Create routine", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Creating routine…" })).toContainText("A new scheduled task");
  await expect(page.locator("form textarea")).toBeDisabled();
  expect(calls).toBe(1); delayed.release();
  await expect(page.locator("form textarea")).toBeEnabled();
  await expect(page.locator("form textarea")).toHaveValue("A new scheduled task");
});

for (const mode of ["send", "queue"] as const) test(`${mode} creates a pending item immediately and restores the draft after failure`, async ({ page }) => {
  const task = await queueSetup(page);
  const delayed = gate(); let calls = 0;
  await page.route("**/api/tasks/t-run/messages", async route => { calls++; await delayed.wait; await route.fulfill({ status: 503, json: { error: "Delivery could not be confirmed" } }); });
  await page.getByRole("textbox").fill("Message before acknowledgment");
  if (mode === "queue") {
    await page.getByRole("button", { name: "Send now", exact: true }).click({ button: "right" });
    await page.getByRole("radio", { name: "Queue", exact: true }).click();
  }
  await page.getByRole("button", { name: mode === "queue" ? "Add to queue" : "Send now", exact: true }).click();
  const pending = mode === "queue" ? page.getByRole("button", { name: /Queued message 1: Message before acknowledgment/ }) : page.getByRole("status", { name: "Pending message" });
  if (mode === "queue") await expect(pending).toContainText("Adding…");
  else {
    await expect(page.getByLabel("Session transcript").getByText("Working…", { exact: true })).toBeVisible();
    await expect(page.getByText("Sending…", { exact: true })).toHaveCount(0);
  }
  await expect(pending).toContainText("Message before acknowledgment");
  if (mode === "send") await expect(page.getByRole("region", { name: "Message queue", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveValue("");
  await expect(page.getByRole("textbox")).toBeDisabled();
  await send(page, "t-run", { type: "tasks", tasks: [task] });
  await expect(pending).toBeVisible();
  await assertViewportLocked(page);
  expect(calls).toBe(1); delayed.release();
  await expect(page.getByRole("textbox")).toHaveValue("Message before acknowledgment");
  await expect(page.getByRole("textbox")).toBeEnabled();
  await expect(pending).toHaveCount(0);
  await expect(page.getByTestId("toast")).toContainText("Delivery could not be confirmed");
});

for (const viewport of [{ width: 360, height: 780 }, { width: 1280, height: 900 }]) test(`send stays separate from waiting turns through acknowledgment at ${viewport.width}px`, async ({ page }) => {
  await page.setViewportSize(viewport);
  const task = await queueSetup(page, [structuredClone(message)]);
  const delayed = gate();
  let accepted!: MessageQueue;
  await page.route("**/api/tasks/t-run/messages", async route => {
    const request = route.request().postDataJSON();
    accepted = { ...task.messageQueue, revision: 2, messages: [message, {
      id: request.clientMessageId, text: request.text, mode: "send", status: "sending", version: 1,
    }] };
    await delayed.wait;
    await route.fulfill({ json: accepted });
  });
  await page.getByRole("textbox").fill("Immediate delivery");
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  const pending = page.getByRole("status", { name: "Pending message" });
  const queue = page.getByRole("region", { name: "Message queue", exact: true });
  await expect(pending).toContainText("Immediate delivery");
  await expect(pending).not.toContainText("Sending…");
  await expect(queue).toContainText("Queue · 1");
  await expect(queue).not.toContainText("Immediate delivery");
  delayed.release();
  await expect(page.getByRole("textbox")).toBeEnabled();
  await expect(pending).not.toContainText("Sending…");
  await expect(queue).toContainText("Queue · 1");
  await assertViewportLocked(page);

  task.messageQueue = accepted;
  await page.evaluate(() => { location.hash = "/routines"; });
  await expect(page.getByRole("heading", { name: "Routines" })).toBeVisible();
  await page.evaluate(() => { location.hash = "/task/t-run"; });
  await send(page, "t-run", { type: "tasks", tasks: [task], historyThrough: 0 });
  await expect(pending).toContainText("Immediate delivery");
  task.messageQueue = { ...accepted, revision: 3, messages: [message] };
  await send(page, "t-run", { type: "tasks", tasks: [task] });
  await expect(pending).toHaveCount(0);
  await expect(queue).toContainText("Queue · 1");
});

for (const mode of ["send", "queue"] as const) test(`${mode} delivery problems stay outside Queue and dismissal rolls back`, async ({ page }) => {
  const problem: PendingMessage = { ...message, id: "problem", mode, text: "Unconfirmed prompt", status: "unknown" };
  const task = await queueSetup(page, [problem, message]);
  task.messageQueue.paused = true;
  task.messageQueue.revision++;
  await send(page, "t-run", { type: "tasks", tasks: [task] });
  const pending = page.getByRole("status", { name: "Pending message" });
  await expect(pending).toContainText("Delivery unconfirmed");
  await expect(pending).toContainText("Check the conversation before sending again");
  await expect(page.getByRole("region", { name: "Message queue", exact: true })).toContainText("Queue paused · 1");
  await expect(page.getByRole("button", { name: "Resume queue", exact: true })).toBeDisabled();
  await assertViewportLocked(page);
  const delayed = gate(); let calls = 0;
  await page.route("**/api/tasks/t-run/messages/problem", async route => {
    calls++; await delayed.wait;
    await route.fulfill({ status: 503, json: { error: "Could not dismiss notice" } });
  });
  await page.getByRole("button", { name: "Dismiss delivery notice" }).click();
  await expect(pending).toHaveCount(0);
  delayed.release();
  await expect(pending).toContainText("Delivery unconfirmed");
  expect(calls).toBe(1);
  problem.status = "rejected";
  task.messageQueue.revision++;
  await send(page, "t-run", { type: "tasks", tasks: [task] });
  await expect(pending).toContainText("Not sent");
  await expect(pending).not.toContainText("Delivery unconfirmed");
});

test("sending a queued message moves it immediately and restores its position on rejection", async ({ page }) => {
  const following = { ...message, id: "following", text: "Following turn" };
  await queueSetup(page, [message, following]);
  const delayed = gate();
  await page.route(`**/api/tasks/t-run/messages/${message.id}`, async route => {
    await delayed.wait; await route.fulfill({ status: 409, json: { error: "The active run changed" } });
  });
  await queueMenu(page, message.text);
  await page.getByRole("button", { name: "Send now", exact: true }).last().click();
  await expect(page.getByRole("status", { name: "Pending message" })).toContainText(message.text);
  await expect(page.getByRole("button", { name: "Queued message 1: Following turn" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Message queue", exact: true })).toContainText("Queue · 1");
  delayed.release();
  await expect(page.getByRole("status", { name: "Pending message" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Queued message 1: Queued original" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Queued message 2: Following turn" })).toBeVisible();
});

test("an automatically started queued turn leaves only waiting turns in Queue", async ({ page }) => {
  const task = await queueSetup(page, [message, { ...message, id: "next", text: "Next turn" }]);
  task.messageQueue = { ...task.messageQueue, revision: 2, messages: [
    { ...message, status: "sending" }, task.messageQueue.messages[1],
  ] };
  await send(page, "t-run", { type: "tasks", tasks: [task] });
  await expect(page.getByRole("status", { name: "Pending message" })).toContainText("Queued original");
  await expect(page.getByRole("button", { name: "Queued message 1: Next turn" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Message queue", exact: true })).toContainText("Queue · 1");
});

test("delivery shows images when the server replaces uploads with durable attachments", async ({ page }) => {
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  await page.route("**/api/tasks/t-run/attachments/*", route => route.fulfill({ contentType: "image/png", body: Buffer.from(image, "base64") }));
  const task = await queueSetup(page, [{ ...message, mode: "send", status: "sending", images: [
    { mediaType: "image/png", data: image },
  ] }]);
  const pending = page.getByRole("status", { name: "Pending message" });
  await expect(pending.getByRole("img", { name: "Attached image 1", exact: true })).toBeVisible();
  task.messageQueue = { ...task.messageQueue, revision: 2, messages: [{
    ...message, mode: "send", status: "sending", attachments: [
      { id: "22222222-2222-4222-8222-222222222222", mediaType: "image/png", size: 1 },
    ],
  }] };
  await send(page, "t-run", { type: "tasks", tasks: [task] });
  await expect(pending.getByRole("img", { name: "Attached image 1", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Message queue", exact: true })).toHaveCount(0);
});

test("a paused send can resume without showing a waiting-turn queue", async ({ page }) => {
  const task = await queueSetup(page, [{ ...message, mode: "send" }]);
  task.messageQueue.paused = true;
  task.messageQueue.revision++;
  await send(page, "t-run", { type: "tasks", tasks: [task] });
  await expect(page.getByRole("status", { name: "Pending message" })).toContainText("Send paused");
  await expect(page.getByRole("region", { name: "Message queue", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Resume delivery" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Cancel send" })).toBeEnabled();
});

test("delivery snapshots settle the optimistic bubble before a stale HTTP response", async ({ page }) => {
  const task = await queueSetup(page);
  const delayed = gate(); let accepted!: MessageQueue;
  await page.route("**/api/tasks/t-run/messages", async route => {
    const request = route.request().postDataJSON();
    accepted = { ...task.messageQueue, revision: 2, messages: [{
      id: request.clientMessageId, text: request.text, mode: "send", status: "sending", version: 1,
    }] };
    await delayed.wait; await route.fulfill({ json: accepted });
  });
  await page.getByRole("textbox").fill("Delivered before HTTP");
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  await expect.poll(() => accepted?.revision).toBe(2);
  task.messageQueue = accepted;
  await send(page, "t-run", { type: "tasks", tasks: [task] });
  await expect(page.getByRole("status", { name: "Pending message" })).toBeVisible();
  task.messageQueue = { ...accepted, revision: 3, messages: [] };
  await send(page, "t-run", { type: "tasks", tasks: [task] });
  await expect(page.getByRole("status", { name: "Pending message" })).toHaveCount(0);
  delayed.release();
  await expect(page.getByRole("textbox")).toBeEnabled();
  await expect(page.getByRole("status", { name: "Pending message" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Message queue", exact: true })).toHaveCount(0);
});

test("a lost send acknowledgment keeps the same id and original run when retried after navigation", async ({ page }) => {
  const task = await queueSetup(page);
  const delayed = gate(); const requests: any[] = [];
  await page.route("**/api/tasks/t-run/messages", async route => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) { await delayed.wait; return route.abort("failed"); }
    await route.fulfill({ json: { ...task.messageQueue, revision: 3 } });
  });
  await page.getByRole("textbox").fill("Only deliver once");
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  await page.evaluate(() => { location.hash = "/routines"; });
  await expect(page.getByRole("heading", { name: "Routines" })).toBeVisible();
  task.messageQueue.runId = "run-2"; task.messageQueue.revision = 2;
  delayed.release(); await expect(page.getByTestId("toast")).toBeVisible();
  await page.evaluate(() => { location.hash = "/task/t-run"; });
  await expect(page.getByRole("textbox")).toHaveValue("Only deliver once");
  await send(page, "t-run", { type: "tasks", tasks: [task], historyThrough: 0 });
  await expect(page.getByRole("button", { name: "Send now", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
  await expect(page.getByRole("textbox")).toHaveValue("");
});

for (const action of ["delete", "send"] as const) test(`queued ${action} is immediate and a conflict cannot resurrect a delivered message`, async ({ page }) => {
  const task = await queueSetup(page, [structuredClone(message)]);
  const delayed = gate();
  await page.route(`**/api/tasks/t-run/messages/${message.id}`, async route => { await delayed.wait; await route.fulfill({ status: 409, json: { error: "Message already delivered" } }); });
  await queueMenu(page, message.text);
  await page.getByRole("button", { name: action === "delete" ? "Remove from queue" : "Send now", exact: true }).last().click();
  if (action === "delete") await expect(page.getByRole("button", { name: /Queued message 1:/ })).toBeHidden();
  else {
    await expect(page.getByRole("button", { name: /Queued message 1:/ })).toBeHidden();
    await expect(page.getByRole("status", { name: "Pending message" })).toBeVisible();
  }
  task.messageQueue.messages = []; task.messageQueue.revision = 2;
  await send(page, "t-run", { type: "tasks", tasks: [task] }); delayed.release();
  await expect(page.getByTestId("toast")).toContainText("Message already delivered");
  await expect(page.getByRole("button", { name: /Queued message 1:/ })).toHaveCount(0);
});

for (const save of [true, false]) test(`queue edit ${save ? "save" : "release"} closes immediately and restores its draft on failure`, async ({ page }) => {
  const task = await queueSetup(page, [structuredClone(message)]);
  const delayed = gate();
  await page.route(`**/api/tasks/t-run/messages/${message.id}`, async route => {
    const input = route.request().postDataJSON();
    if (input.action === "save" || input.action === "release") { await delayed.wait; return route.fulfill({ status: 409, json: { error: "Edit lease expired" } }); }
    task.messageQueue.revision++;
    await route.fulfill({ json: task.messageQueue });
  });
  await queueMenu(page, message.text); await page.getByRole("button", { name: "Edit prompt", exact: true }).click();
  await expect(page.getByRole("textbox")).toHaveValue(message.text);
  await page.getByRole("textbox").fill("Edited pending text");
  await page.getByRole("button", { name: save ? "Save queued message" : "Cancel editing", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save queued message" })).toHaveCount(0);
  if (save) await expect(page.getByRole("button", { name: /Queued message 1: Edited pending text/ })).toBeVisible();
  delayed.release();
  await expect(page.getByRole("textbox")).toHaveValue("Edited pending text");
  await expect(page.getByText("Edit expired — draft preserved")).toBeVisible();
  await expect(page.getByTestId("toast")).toContainText("Edit lease expired");
});

test("dispatch shows a pending task, prevents duplicate submits, and restores its draft", async ({ page }) => {
  const delayed = gate(); let calls = 0;
  await page.route("**/api/tasks", async route => {
    if (route.request().method() !== "POST") return route.continue();
    calls++; await delayed.wait; await route.fulfill({ status: 503, json: { error: "Dispatcher unavailable" } });
  });
  await page.goto("/#/new"); await page.getByRole("textbox", { name: "Prompt" }).fill("A task awaiting an id");
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Creating task…" })).toContainText("A task awaiting an id");
  await expect(page.getByRole("textbox", { name: "Prompt" })).toBeDisabled();
  expect(calls).toBe(1); delayed.release();
  await expect(page.getByRole("textbox", { name: "Prompt" })).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "Prompt" })).toHaveValue("A task awaiting an id");
});

test("archive leaves the inbox immediately and restores the task with a toast if it fails", async ({ page }) => {
  const delayed = gate(); let calls = 0;
  await page.route("**/api/tasks/t-idle-rich", async route => {
    if (route.request().method() !== "DELETE") return route.continue();
    calls++; await delayed.wait; await route.fulfill({ status: 503, json: { error: "Worktree could not be removed" } });
  });
  await page.goto("/#/task/t-idle-rich"); await page.getByRole("button", { name: "Task actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await page.getByRole("button", { name: "Archive task", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Actions for Wire the web QA harness", exact: true })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Archiving task…" })).toBeVisible();
  expect(calls).toBe(1); delayed.release();
  await expect(page.getByRole("button", { name: "Actions for Wire the web QA harness", exact: true })).toBeVisible();
  await expect(page.getByTestId("toast")).toContainText("Couldn't archive this task");
});

test("repository removal hides its row immediately and restores it on a server conflict", async ({ page }) => {
  const delayed = gate(); let calls = 0;
  await page.route("**/api/repos/discover*", route => route.fulfill({ json: { repos: repos.map(r => ({ ...r, branch: "main", lastActivityAt: 1 })) } }));
  await page.route("**/api/repos/repo-app", async route => { calls++; await delayed.wait; await route.fulfill({ status: 409, json: { error: "Repository has active tasks" } }); });
  page.on("dialog", dialog => void dialog.accept());
  await page.goto("/#/new"); await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Remove sample-app", exact: true }).click();
  await expect(page.getByRole("option", { name: /sample-app/ })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Removing repository…" })).toBeVisible();
  expect(calls).toBe(1); delayed.release();
  await expect(page.getByRole("button", { name: "Remove sample-app", exact: true })).toBeVisible();
  await expect(page.getByTestId("toast")).toContainText("Repository has active tasks");
});

test("registration shows the pending path without exposing a fabricated repository id", async ({ page }) => {
  const delayed = gate(); let calls = 0;
  await page.route("**/api/repos", async route => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { repos } });
    calls++; await delayed.wait; await route.fulfill({ status: 400, json: { error: "Directory unavailable" } });
  });
  await page.goto("/#/new"); await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("option", { name: "Browse folders…" }).click();
  await page.getByRole("button", { name: "Choose outer-repo as repository" }).click();
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "/projects/outer-repo · Registering…" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Registering…", exact: true })).toBeDisabled();
  expect(calls).toBe(1); delayed.release();
  await expect(page.getByRole("button", { name: "Register", exact: true })).toBeEnabled();
  await expect(page.getByTestId("toast")).toContainText("Directory unavailable");
});

test("failed sign-out stays on the current page and keeps the request guarded", async ({ page }) => {
  const delayed = gate(); let calls = 0;
  await page.route("**/api/auth/me", route => route.fulfill({ json: { required: true, authenticated: true } }));
  await page.route("**/api/auth/logout", async route => { calls++; await delayed.wait; await route.fulfill({ status: 503, json: { error: "Sign-out unavailable" } }); });
  await page.goto("/"); await settings(page);
  await page.evaluate(() => { (window as any).sameDocument = true; });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Signing out…", exact: true })).toBeDisabled();
  expect(calls).toBe(1); delayed.release();
  await expect(page.getByTestId("toast")).toContainText("Couldn't sign out");
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).sameDocument)).toBe(true);
});

test("Stop stays pending after acceptance until the live run actually stops", async ({ page }) => {
  const task = await queueSetup(page);
  let calls = 0;
  await page.route("**/api/tasks/t-run/stop", route => { calls++; return route.fulfill({ json: { task } }); });
  await page.getByRole("button", { name: "Task actions", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Stop", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => calls).toBe(1);
  await expect(page.getByRole("status").filter({ hasText: "Stopping turn…" })).toBeVisible();
  const actions = page.getByRole("button", { name: "Task actions", exact: true });
  await expect(actions).toBeEnabled();
  await actions.click();
  await expect(page.getByRole("menuitem", { name: "Session details", exact: true })).toBeEnabled();
  await expect(page.getByRole("menuitem", { name: "Rename", exact: true })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Open terminal", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await send(page, "t-run", { type: "tasks", tasks: [{ ...task, status: "idle", interrupted: true, updatedAt: task.updatedAt + 1 }] });
  await expect(page.getByRole("status").filter({ hasText: "Stopping turn…" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Task actions", exact: true })).toBeEnabled();
});

for (const decision of ["approve", "deny"] as const) test(`${decision} waits for confirmation and restores controls on failure`, async ({ page }) => {
  const delayed = gate(); let calls = 0;
  await page.route("**/api/tasks/t-await/approve", async route => { calls++; await delayed.wait; await route.fulfill({ status: 503, json: { error: "Approval unavailable" } }); });
  await page.goto("/#/task/t-await");
  await page.getByRole("button", { name: decision === "approve" ? "Approve" : "Deny", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: decision === "approve" ? "Approving…" : "Denying…" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  expect(calls).toBe(1); delayed.release();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
  await expect(page.getByTestId("toast")).toContainText("Approval unavailable");
});

test("an obsolete preference failure cannot roll back or toast over a newer selection", async ({ page }) => {
  const delayed = gate(); let writes = 0;
  await page.route("**/api/settings/updates", async route => {
    if (route.request().method() === "PATCH") { writes++; await delayed.wait; return route.fulfill({ status: 503, json: { error: "Old request failed" } }); }
    await route.fulfill({ json: updateSettings });
  });
  await page.goto("/"); await settings(page, "Updates");
  const control = page.getByRole("switch", { name: "Automatic updates" });
  await control.click(); await expect.poll(() => writes).toBe(1);
  await control.click(); await expect(control).not.toBeChecked();
  delayed.release();
  await expect(control).toHaveAttribute("aria-busy", "false");
  await expect(control).not.toBeChecked();
  await expect(page.getByTestId("toast")).toHaveCount(0);
  expect(writes).toBe(1);
});

test("a combined channel and automatic-update choice saves the channel before enabling automation", async ({ page }) => {
  const state = structuredClone(updateSettings) as UpdateSettingsStatus;
  const calls: any[] = [];
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.route("**/api/settings/updates", async route => {
    if (route.request().method() === "PATCH") { const change = route.request().postDataJSON(); calls.push(change); Object.assign(state.settings!, change); }
    await route.fulfill({ json: state });
  });
  await page.goto("/"); await settings(page, "Updates");
  await page.clock.pauseAt(new Date("2026-01-01T00:01:00Z"));
  await page.getByRole("switch", { name: "Automatic updates" }).click();
  await page.getByRole("radio", { name: "Stable", exact: true }).click();
  await page.clock.runFor(251);
  await expect.poll(() => calls).toEqual([{ channel: "stable" }, { autoUpdate: true }]);
});

test("successful dispatch clears the submitted attachments before the next task", async ({ page }) => {
  await page.route("**/api/tasks", route => route.request().method() === "POST"
    ? route.fulfill({ json: { task: tasks.find(t => t.taskId === "t-idle-rich") } }) : route.continue());
  await page.goto("/#/new");
  await page.getByLabel("Attach photos", { exact: true }).setInputFiles({ name: "sample.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64") });
  await expect(page.getByAltText("attachment 1")).toBeVisible();
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  await expect(page).toHaveURL(/task\/t-idle-rich$/);
  await page.evaluate(() => { location.hash = "/new"; });
  await expect(page.getByRole("textbox", { name: "Prompt" })).toHaveValue("");
  await expect(page.getByAltText("attachment 1")).toHaveCount(0);
});

for (const fail of [false, true]) test(`composer Stop is immediate and serialized behind a ${fail ? "failed" : "successful"} send`, async ({ page }) => {
  const task = await queueSetup(page);
  const delayed = gate(); const calls: string[] = [];
  await page.route("**/api/tasks/t-run/messages", async route => {
    calls.push("send"); await delayed.wait;
    await route.fulfill(fail ? { status: 503, json: { error: "Send unavailable" } } : { json: { ...task.messageQueue, revision: 2 } });
  });
  await page.route("**/api/tasks/t-run/stop", route => { calls.push("stop"); return route.fulfill({ json: { task } }); });
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Interrupt this prompt");
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  const stop = page.getByRole("group", { name: "Message composer", exact: true }).getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeEnabled();
  const stopBox = await stop.boundingBox();
  expect(stopBox!.width).toBeGreaterThanOrEqual(44);
  expect(stopBox!.height).toBeGreaterThanOrEqual(44);
  const stopVisual = stop.locator("[data-stop-visual]");
  await expect(stopVisual).toHaveCSS("width", "40px");
  await expect(stopVisual).toHaveCSS("height", "40px");
  await expect(stop.locator(".animate-spin")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send now", exact: true })).toHaveCount(0);
  await stop.click(); await expect(stop).toBeDisabled();
  expect(calls).toEqual(["send"]);
  // The request and the stop intent survive leaving and reopening the task.
  await page.evaluate(() => { location.hash = "/"; });
  await expect(page.getByRole("button", { name: "Dispatch new task", exact: true })).toBeVisible();
  await page.evaluate(() => { location.hash = "/task/t-run"; });
  await expect(stop).toBeDisabled();
  delayed.release();
  await expect.poll(() => calls).toEqual(["send", "stop"]);
  await send(page, "t-run", { type: "tasks", tasks: [{ ...task, status: "idle", updatedAt: task.updatedAt + 1 }] });
  await expect(stop).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(fail ? "Interrupt this prompt" : "");
});

test("new task shows Stop before creation completes and stops the returned task", async ({ page }) => {
  const delayed = gate(); const calls: string[] = [];
  const task = tasks.find(t => t.taskId === "t-run")!;
  await page.route("**/api/tasks", async route => {
    if (route.request().method() !== "POST") return route.continue();
    calls.push("create"); await delayed.wait; await route.fulfill({ json: { task } });
  });
  await page.route("**/api/tasks/t-run/stop", route => { calls.push("stop"); return route.fulfill({ json: { task: { ...task, status: "idle" } } }); });
  await page.goto("/#/new"); await page.getByRole("textbox", { name: "Prompt" }).fill("Stop after creating");
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeEnabled(); await expect(stop.locator(".animate-spin")).toHaveCount(0);
  await stop.click(); await expect(stop).toBeDisabled();
  expect(calls).toEqual(["create"]); delayed.release();
  await expect.poll(() => calls).toEqual(["create", "stop"]);
  await expect(page).toHaveURL(/task\/t-run/);
});

for (const id of ["t-input", "t-await"]) test(`composer keeps Stop available on ${id}`, async ({ page }) => {
  await page.goto(`/#/task/${id}`);
  const composer = page.getByRole("group", { name: "Message composer", exact: true });
  await expect(composer.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Task actions", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Stop", exact: true })).toHaveCount(0);
});

test("a follow-up draft replaces Stop, and clearing it restores Stop", async ({ page }) => {
  await queueSetup(page);
  const composer = page.getByRole("group", { name: "Message composer", exact: true });
  const input = composer.getByRole("textbox", { name: "Message", exact: true });
  const stop = composer.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeEnabled();
  await input.fill("Keep this follow-up");
  await expect(stop).toHaveCount(0);
  await expect(composer.getByRole("button", { name: "Send now", exact: true })).toBeVisible();
  await input.fill("   ");
  await expect(stop).toBeEnabled();
});

test("a failed Stop can be retried while keeping the composer usable", async ({ page }) => {
  await queueSetup(page);
  await page.route("**/api/tasks/t-run/stop", route => route.fulfill({ status: 503, json: { error: "Stop unavailable" } }));
  const composer = page.getByRole("group", { name: "Message composer", exact: true });
  await composer.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByTestId("toast")).toContainText("Stop unavailable");
  await expect(composer.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  const input = composer.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Keep this follow-up");
  await expect(input).toHaveValue("Keep this follow-up");
  await expect(composer.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
});
