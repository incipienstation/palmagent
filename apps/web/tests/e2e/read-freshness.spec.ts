import { test, expect } from "@playwright/test";
import { installInbox, send, type InboxHarness } from "./_inbox-stream";
import { repos, routines, tasks, usage } from "../fixtures.mjs";

test.use({ serviceWorkers: "block" });

function gate() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); return { wait, release }; }

for (const warm of [false, true]) test(`stream changes during ${warm ? "cached" : "initial"} reads and their follow-up are not lost`, async ({ page }) => {
  await installInbox(page);
  const first = gate(), second = gate();
  let reads = 0;
  const heldRead = warm ? 2 : 1;
  await page.route("**/api/usage", async route => {
    const read = ++reads;
    if (read === heldRead) await first.wait;
    if (read === heldRead + 1) await second.wait;
    await route.fulfill({ json: { usage: usage.map(row => ({ ...row, taskCount: read > heldRead + 1 ? 333 : 111 })) } });
  });
  await page.goto("/#/usage");
  if (warm) {
    await expect(page.getByText("111", { exact: true }).first()).toBeVisible();
    await send(page, { type: "read-change", usage: true });
  }
  await expect.poll(() => reads).toBe(heldRead);
  // A burst should require just one trailing read, even on a cold cache.
  for (let i = 0; i < 3; i++) await send(page, { type: "read-change", usage: true });
  expect(reads).toBe(heldRead);
  first.release();
  await expect.poll(() => reads).toBe(heldRead + 1);
  await send(page, { type: "read-change", usage: true });
  second.release();
  await expect(page.getByText("333", { exact: true }).first()).toBeVisible();
  expect(reads).toBe(heldRead + 2);
});

for (const trigger of ["reconnect", "deletion"] as const) test(`Spaces refresh after a remote ${trigger}`, async ({ page }) => {
  await installInbox(page);
  let deleted = false, reads = 0;
  await page.route("**/api/repos", route => {
    reads++;
    return route.fulfill({ json: { repos: deleted ? repos.slice(1) : repos } });
  });
  await page.goto("/#/spaces");
  await expect(page.getByRole("region", { name: "Spaces list" }).getByText(repos[0].name, { exact: true })).toBeVisible();
  const previous = reads;
  deleted = true;
  if (trigger === "reconnect") {
    // Native EventSource recovery on the same connection, with no foreground
    // or browser online event to independently refresh the REST cache.
    await page.evaluate(() => {
      const inbox = (window as unknown as InboxHarness).inbox;
      inbox.onerror?.(new Event("error"));
      inbox.onopen?.(new Event("open"));
    });
    await send(page, { type: "tasks", tasks });
  } else {
    await send(page, { type: "read-change", repos: true, usage: true, routines: true });
  }
  await expect(page.getByRole("region", { name: "Spaces list" }).getByText(repos[0].name, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Spaces list" }).getByText(repos[1].name, { exact: true })).toBeVisible();
  expect(reads).toBe(previous + 1);
});

for (const scope of ["routines", "repos"] as const) test(`cached ${scope} stay mounted with visible refresh errors and retry`, async ({ page }) => {
  await installInbox(page);
  const retry = gate();
  let reads = 0, failedRead = 0;
  let phase: "initial" | "fail" | "retry" = "initial";
  await page.route(`**/api/${scope}`, async route => {
    const read = ++reads;
    if (phase === "fail") { failedRead = read; phase = "retry"; return route.fulfill({ status: 503, json: { error: "Refresh unavailable" } }); }
    if (phase === "retry") await retry.wait;
    return route.fulfill({ json: scope === "repos" ? { repos } : { routines } });
  });
  await page.goto(scope === "repos" ? "/#/spaces" : "/#/routines");
  const cached = scope === "repos" ? page.getByRole("region", { name: "Spaces list" }).getByText(repos[0].name, { exact: true }) : page.getByRole("switch", { name: "Enabled" }).first();
  await expect(cached).toBeVisible();
  const row = await cached.elementHandle();
  if (scope === "routines") await page.getByRole("button", { name: "New routine", exact: true }).click();
  const input = scope === "repos" ? page.getByRole("searchbox", { name: "Search Spaces" }) : page.getByLabel("Title (optional)");
  await input.fill(scope === "repos" ? repos[0].name : "Unsaved routine title");
  const draft = await input.elementHandle();
  phase = "fail";
  await send(page, { type: "read-change", [scope]: true });
  const alert = page.getByRole("alert").filter({ hasText: "Refresh unavailable" });
  await expect(alert).toBeVisible();
  expect(await row!.evaluate(el => el.isConnected)).toBe(true);
  const button = alert.getByRole("button", { name: scope === "repos" ? "Retry" : "Retry routines", exact: true });
  await button.click();
  await expect(button).toBeDisabled();
  await expect(alert).toBeVisible();
  expect(await draft!.evaluate(el => el.isConnected)).toBe(true);
  await expect(input).toHaveValue(scope === "repos" ? repos[0].name : "Unsaved routine title");
  retry.release();
  await expect(alert).toHaveCount(0);
  expect(await row!.evaluate(el => el.isConnected)).toBe(true);
  expect(reads).toBe(failedRead + 1);
});

test("terminal SSE changes coalesce during slow reads without idle polling", async ({ page }) => {
  await installInbox(page);
  await page.clock.install();
  const first = gate(), second = gate();
  let reads = 0;
  await page.route("**/api/terminals", async route => {
    await (++reads === 1 ? first.wait : second.wait);
    await route.fulfill({ json: { terminals: [], capabilities: { available: true } } });
  });
  await page.goto("/#/terminals");
  await expect.poll(() => reads).toBe(1);
  await page.clock.fastForward(11_000);
  expect(reads).toBe(1);
  first.release();
  await expect(page.getByText("Open a terminal to work in this directory.")).toBeVisible();
  await send(page, { type: "read-change", terminals: true });
  await expect.poll(() => reads).toBe(2);
  await page.clock.fastForward(11_000);
  expect(reads).toBe(2);
  second.release();
  await expect(page.getByRole("combobox", { name: "Select terminal" })).toContainText("No terminal yet");
});

test("a pending terminal read cannot remove a newly created terminal", async ({ page }) => {
  await installInbox(page);
  await page.clock.install();
  const poll = gate(), refresh = gate();
  let reads = 0;
  const terminal = { id: "80a6a201-c6df-4229-ae7c-7b6b42b72d2f", repoId: "repo-app", title: "New shell", initialCwd: "/projects/sample-app", state: "exited", createdAt: 1 };
  await page.route("**/api/terminals*", async route => {
    if (route.request().method() === "POST") return route.fulfill({ json: { terminal } });
    const read = ++reads;
    if (read === 2) await poll.wait;
    if (read > 2) await refresh.wait;
    await route.fulfill({ json: { terminals: read > 2 ? [terminal] : [], capabilities: { available: true } } });
  });
  await page.goto("/#/terminals/repo/repo-app");
  const create = page.getByRole("button", { name: "New terminal", exact: true });
  await expect(create).toBeEnabled();
  await send(page, { type: "read-change", terminals: true });
  await expect.poll(() => reads).toBe(2);
  await create.click();
  await expect.poll(() => reads).toBe(3);
  const selection = page.getByRole("combobox", { name: "Select terminal" });
  await expect(selection).toContainText("New shell");
  const response = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/terminals");
  poll.release();
  await (await response).finished();
  await expect(selection).toContainText("New shell");
  refresh.release();
  await expect(create).toBeEnabled();
  await expect(selection).toContainText("New shell");
});

test("terminal reconnect recovers remote edits and preserves an open rename draft", async ({ page }) => {
  await installInbox(page);
  await page.clock.install();
  let title = "Original shell", reads = 0;
  const id = "80a6a201-c6df-4229-ae7c-7b6b42b72d2f";
  await page.route("**/api/terminals", route => {
    reads++;
    return route.fulfill({ json: { capabilities: { available: true, persistent: true }, terminals: [
      { id, repoId: "repo-app", title, initialCwd: "/projects/sample-app", state: "exited", createdAt: 1 },
    ] } });
  });
  await page.goto("/#/terminals");
  const selection = page.getByRole("combobox", { name: "Select terminal" });
  await expect(selection).toContainText("Original shell");
  await page.getByRole("button", { name: "Terminal actions" }).click();
  await page.getByRole("menuitem", { name: "Rename terminal" }).click();
  const draft = page.getByRole("textbox", { name: "Terminal name" });
  await draft.fill("Unsubmitted name");
  const before = reads;
  await page.clock.fastForward(60_000);
  expect(reads).toBe(before);
  title = "Remote rename";
  await page.evaluate(() => {
    const inbox = (window as unknown as InboxHarness).inbox;
    inbox.onerror?.(new Event("error")); inbox.onopen?.(new Event("open"));
  });
  await send(page, { type: "tasks", tasks });
  await expect(selection).toContainText("Remote rename");
  await expect(draft).toHaveValue("Unsubmitted name");
  expect(reads).toBe(before + 1);
});
