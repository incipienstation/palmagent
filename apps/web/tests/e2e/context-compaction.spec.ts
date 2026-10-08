import { test, expect, type Page } from "@playwright/test";
import type { CompactTaskRequest, TaskHistoryEvent, TaskState } from "@palmagent/shared";
import { tasks } from "../fixtures.mjs";
import { installScopedStream, open, send, type Harness } from "./_scoped-stream";
import { assertViewportLocked } from "./_helpers";

test.use({ serviceWorkers: "block" });
async function setup(page: Page, patch: Partial<TaskState> = {}) {
  await installScopedStream(page);
  const task: TaskState = { ...tasks.find(t => t.taskId === "t-idle-rich")!, agent: "codex", model: undefined,
    messageQueue: { revision: 1, paused: false, runId: null, messages: [] }, ...patch };
  const events: TaskHistoryEvent[] = Array.from({ length: 20 }, (_, index) => ({ seq: index + 1, event: {
    taskId: task.taskId, agent: "codex", kind: "assistant_text", ts: index + 1,
    payload: { text: `Earlier response ${index + 1}.\n\n${"Keep this conversation readable while managing the session. ".repeat(12)}` },
  } }));
  const requests: CompactTaskRequest[] = [];
  let failure: string | undefined;
  await page.route(`**/api/tasks/${task.taskId}`, route => route.fulfill({ json: { task } }));
  await page.route(new RegExp(`/api/tasks/${task.taskId}/history(?:\\?.*)?$`), route => route.fulfill({ json: { events, before: null, cursor: events.length } }));
  await page.route(`**/api/tasks/${task.taskId}/history/changes?*`, route => {
    const query = new URL(route.request().url()).searchParams;
    const after = Number(query.get("after")), through = Number(query.get("through"));
    return route.fulfill({ json: { after, through, nextAfter: null, events: events.filter(event => event.seq > after && event.seq <= through) } });
  });
  await page.route(`**/api/tasks/${task.taskId}/compact`, async route => {
    const request = route.request().postDataJSON() as CompactTaskRequest;
    requests.push(request);
    if (failure) return route.fulfill({ status: 503, json: { error: failure } });
    task.status = "running"; task.updatedAt++;
    task.messageQueue = { ...task.messageQueue!, revision: task.messageQueue!.revision + 1, runId: "compaction-run",
      compaction: { requestId: request.requestId, status: "running" } };
    await route.fulfill({ status: 202, json: { task } });
  });
  const snapshot = async () => {
    await expect.poll(() => page.evaluate(id => (window as unknown as Harness).hasScopedStream(id), task.taskId)).toBe(true);
    await send(page, task.taskId, { type: "tasks", tasks: [task], historyThrough: events.length });
  };
  await open(page, task.taskId, { serverHistory: true }); await snapshot();
  if (!task.sessionControl || task.sessionControl.owner === "palmagent") await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  return { task, requests, snapshot, fail: (message?: string) => { failure = message; },
    complete: async (error?: string) => {
      task.status = error ? "failed" : "idle"; task.updatedAt++;
      task.messageQueue = { ...task.messageQueue!, revision: task.messageQueue!.revision + 1, runId: null,
        compaction: { ...task.messageQueue!.compaction!, status: error ? "failed" : "completed", error } };
      if (!error) {
        const event: TaskHistoryEvent = { seq: events.length + 1, event: { taskId: task.taskId, agent: "codex", ts: Date.now(), kind: "status", payload: { subtype: "context_compacted" } } };
        events.push(event);
        await send(page, task.taskId, { type: "event", event: event.event }, event.seq);
      }
      await snapshot();
    },
  };
}
async function menu(page: Page) { await page.getByRole("button", { name: "Task actions", exact: true }).click(); }

for (const width of [360, 1280]) test(`compaction menu and lifecycle preserve draft and reading position at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 780 });
  const f = await setup(page);
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Keep my next question");
  const viewport = page.locator("[data-radix-scroll-area-viewport]").first();
  await viewport.hover(); await page.mouse.wheel(0, -600);
  await expect.poll(() => viewport.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeGreaterThan(100);
  await page.waitForTimeout(200);
  const before = await viewport.evaluate(el => el.scrollTop);
  await menu(page);
  await expect(page.getByRole("menuitem")).toHaveText(["Pin", "Rename", "Compact context", "Open terminal", "Session details", "Archive", "Cancel…"]);
  await expect(page.getByRole("menu").getByRole("separator")).toHaveCount(2);
  await page.getByRole("menuitem", { name: "Compact context", exact: true }).click();
  const intro = page.getByRole("alertdialog", { name: "Compact context?" });
  await expect(intro).toContainText("Some details may be omitted");
  await intro.getByRole("button", { name: "Compact context", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Compacting context…" })).toBeVisible();
  await expect(draft).toHaveValue("Keep my next question");
  await expect(draft).toBeEnabled();
  await draft.fill("Keep my next question, edited during compaction");
  await expect.poll(() => f.requests.length).toBe(1);
  await menu(page);
  await expect(page.getByRole("menuitem", { name: /Compact context/ })).toBeDisabled();
  await expect(page.getByRole("menu")).toContainText("Context compaction is in progress.");
  await page.keyboard.press("Escape");
  await f.snapshot();
  await f.complete();
  await expect(page.getByRole("status").filter({ hasText: "Compacting context…" })).toHaveCount(0);
  await expect(draft).toHaveValue("Keep my next question, edited during compaction");
  expect(Math.abs(await viewport.evaluate(el => el.scrollTop) - before)).toBeLessThan(8);
  await viewport.hover(); await page.mouse.wheel(0, 100000);
  await expect(page.getByText("Context compacted", { exact: true })).toBeVisible();
  await assertViewportLocked(page);
  await menu(page); await page.getByRole("menuitem", { name: "Compact context", exact: true }).click();
  await expect.poll(() => f.requests.length).toBe(2);
  await expect(intro).toHaveCount(0);
});

test("slash command uses compaction and restores running state after reload", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pref:context-compaction-explained", "1"));
  const f = await setup(page);
  let messages = 0;
  await page.route("**/api/tasks/*/messages", async route => { messages++; await route.fulfill({ status: 500, json: { error: "Unexpected ordinary message" } }); });
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("/compact"); await draft.press("Control+Enter");
  await expect.poll(() => f.requests.length).toBe(1);
  await expect(draft).toHaveValue("");
  expect(messages).toBe(0);
  await draft.fill("Draft during compaction");
  await page.reload(); await f.snapshot();
  await expect(page.getByRole("status").filter({ hasText: "Compacting context…" })).toBeVisible();
  await expect(draft).toHaveValue("Draft during compaction");
  await f.complete("Provider unavailable");
  await expect(page.getByRole("alert").filter({ hasText: "Provider unavailable" })).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => f.requests.length).toBe(2);
  await expect(draft).toHaveValue("Draft during compaction");
  await f.complete();
});

test("failed admission retains slash command and retry identity", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pref:context-compaction-explained", "1"));
  const f = await setup(page); f.fail("Temporarily unavailable");
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("/compact"); await draft.press("Control+Enter");
  await expect(page.getByRole("alert").filter({ hasText: "Temporarily unavailable" })).toBeVisible();
  await expect(draft).toHaveValue("/compact");
  f.fail(); await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(draft).toHaveValue("");
  expect(f.requests[1]).toEqual(f.requests[0]);
});

for (const [name, patch, reason] of [
  ["active", { status: "running" }, "Available after the response finishes."],
  ["local", { sessionControl: { owner: "local", home: "/tmp/provider", transcript: "/tmp/transcript", cursor: 0, prefixHash: "" } }, "Continue this session in Palmagent first."],
] as const) test(`${name} session explains why compaction is unavailable`, async ({ page }) => {
  const f = await setup(page, patch);
  await menu(page);
  await expect(page.getByRole("menuitem", { name: /Compact context/ })).toBeDisabled();
  await expect(page.getByRole("menu")).toContainText(reason);
  expect(f.requests).toHaveLength(0);
});

test("unsupported agents omit compaction from the menu", async ({ page }) => {
  await setup(page, { agent: "claude" }); await menu(page);
  await expect(page.getByRole("menuitem", { name: /Compact context/ })).toHaveCount(0);
});
