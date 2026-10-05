import { test, expect } from "@playwright/test";
import { tasks } from "../fixtures.mjs";

test.use({ serviceWorkers: "block" });
function gate() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); return { wait, release }; }

test("terminal creation uses its response without an empty frame or waiting for the list", async ({ page }) => {
  const initial = gate(), refresh = gate(); let reads = 0;
  const terminal = { id: "80a6a201-c6df-4229-ae7c-7b6b42b72d2f", repoId: "repo-app", title: "New shell", initialCwd: "/projects/sample-app", state: "running", createdAt: 1, protocol: 1 };
  await page.route("**/api/terminals**", async route => {
    if (route.request().url().endsWith("attach-ticket")) return route.fulfill({ json: { ticket: "ticket", protocol: 1 } });
    if (route.request().method() === "POST") return route.fulfill({ json: { terminal } });
    reads++; await (reads === 1 ? initial.wait : refresh.wait);
    await route.fulfill({ json: { terminals: reads === 1 ? [] : [terminal], capabilities: { available: true, persistent: true } } });
  });
  await page.routeWebSocket("**/api/terminals/*/stream", ws => ws.onMessage(() => {}));
  await page.goto("/#/terminals/repo/repo-app");
  await expect(page.getByText("Open a terminal to work in this directory.")).toHaveCount(0);
  initial.release();
  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Select terminal" })).toContainText("New shell");
  await expect(page.getByText("Open a terminal to work in this directory.")).toHaveCount(0);
  await expect(page.locator(".xterm")).toBeVisible();
  refresh.release();
});

for (const mode of ["send", "queue"] as const) test(`a cold conversation keeps its ${mode} composer through the first snapshot`, async ({ page }) => {
  const delayed = gate();
  await page.route("**/api/stream?*", async route => { await delayed.wait; await route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "tasks", tasks: [task], historyThrough: 0 })}\n\n` }); });
  const task = tasks.find(task => task.taskId === "t-idle") ?? tasks.find(task => task.status === "idle")!;
  await page.route(`**/api/tasks/${task.taskId}/history*`, async route => {
    await delayed.wait;
    await route.fulfill({ json: { events: [], cursor: 0, before: null, task } });
  });
  await page.addInitScript(({ id, mode }) => { localStorage.setItem(`delivery:${id}`, mode); localStorage.setItem(`draft:compose:${id}`, "Saved draft"); }, { id: task.taskId, mode });
  await page.goto(`/#/task/${task.taskId}`);
  await expect(page.getByRole("heading", { name: "Conversation", exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: "Loading conversation", exact: true })).toBeVisible();
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(composer).toBeVisible();
  await expect(composer).toBeDisabled();
  const node = await composer.elementHandle();
  await expect(page.getByRole("button", { name: mode === "send" ? "Send now" : "Add to queue", exact: true })).toBeDisabled();
  delayed.release();
  await expect(page.getByRole("heading", { name: "Conversation", exact: true })).toHaveCount(0);
  await expect(page.getByRole("status", { name: "Loading conversation", exact: true })).toHaveCount(0);
  expect(await node!.evaluate(el => el.isConnected)).toBe(true);
});

test("path validation retains the confirmation area and ignores superseded responses", async ({ page }) => {
  const old = gate();
  let oldFinished = false;
  await page.route("**/api/repos/validate?*", async route => {
    const path = new URL(route.request().url()).searchParams.get("path")!;
    if (path.endsWith("/old")) await old.wait;
    await route.fulfill({ json: { exists: true, isDir: true, isGit: true, root: path, resolved: path, branch: "main", suggestions: [] } });
    if (path.endsWith("/old")) oldFinished = true;
  });
  await page.goto("/#/new/space/repo-app");
  await page.getByRole("combobox", { name: "Space", exact: true }).click();
  await page.getByRole("option", { name: "Add Space", exact: true }).click();
  await page.getByRole("option", { name: "Enter a path manually…" }).click();
  const path = page.getByLabel("Absolute path (or ~/…)");
  await path.fill("/projects/first");
  const connect = page.getByRole("button", { name: "Connect Space", exact: true });
  await expect(connect).toBeEnabled();
  const node = await connect.elementHandle();
  const requested = page.waitForRequest("**/api/repos/validate?path=**old");
  await path.fill("/projects/old"); await requested;
  await expect(connect).toBeDisabled();
  expect(await node!.evaluate(el => el.isConnected)).toBe(true);
  const cancelled = page.waitForEvent("requestfailed", request => new URL(request.url()).searchParams.get("path") === "/projects/old");
  await path.fill("/projects/new");
  expect((await cancelled).failure()).not.toBeNull();
  await expect(connect).toBeEnabled();
  await expect(page.getByText("/projects/new", { exact: true })).toBeVisible();
  old.release(); await expect.poll(() => oldFinished).toBe(true);
  await expect(page.getByText("/projects/new", { exact: true })).toBeVisible();
  await expect(page.getByText("/projects/old", { exact: true })).toHaveCount(0);
});

test("Spaces refresh failures retain rows and allow another pull without reloading", async ({ page }) => {
  await page.goto("/#/spaces");
  const row = page.getByRole("button", { name: /sample-app/ }).first();
  await expect(row).toBeVisible();
  const node = await row.elementHandle();
  let calls = 0, loads = 0;
  page.on("load", () => loads++);
  await page.route("**/api/tasks", route => { calls++; return route.fulfill({ status: 503, json: { error: "Try again" } }); });
  const pull = () => page.locator("[data-radix-scroll-area-viewport]").filter({ has: row }).evaluate(el => {
    el.scrollTop = 0;
    for (const [type, y] of [["touchstart", 20], ["touchmove", 180], ["touchend", 180]] as const) {
      el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: [new Touch({ identifier: 1, target: el, clientX: 100, clientY: y })] }));
    }
  });
  await pull();
  await expect(page.getByRole("alert")).toContainText("Could not refresh");
  expect(await node!.evaluate(el => el.isConnected)).toBe(true);
  await pull();
  await expect.poll(() => calls).toBe(2);
  expect(loads).toBe(0);
});
