import { test, expect, type Page } from "@playwright/test";
import type { SideChatSnapshot, TaskState, TaskHistoryEvent } from "@palmagent/shared";
import { tasks } from "../fixtures.mjs";
import { installScopedStream, open, send } from "./_scoped-stream";
import { assertViewportLocked } from "./_helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(60_000);
async function setup(page: Page) {
  await installScopedStream(page);
  const task: TaskState = { ...tasks.find(t => t.taskId === "t-idle-rich")!, agent: "codex", model: undefined,
    messageQueue: { revision: 1, paused: false, runId: null, messages: [] } };
  let side: SideChatSnapshot | null = null;
  const calls: { path: string; method: string; body: any }[] = [];
  let counter = 0, unavailable = false;
  await page.route(`**/api/tasks/${task.taskId}`, route => route.fulfill({ json: { task } }));
  const events: TaskHistoryEvent[] = Array.from({ length: 20 }, (_, index) => ({ seq: index + 1, event: {
    taskId: task.taskId, agent: "codex", kind: "assistant_text", ts: index + 1,
    payload: { text: `Earlier response ${index + 1}.\n\n${"Keep the reading position while asking a side question. ".repeat(12)}` },
  } }));
  await page.route(new RegExp(`/api/tasks/${task.taskId}/history(?:\\?.*)?$`), route => route.fulfill({ json: { events, before: null, cursor: events.length } }));
  await page.route(`**/api/tasks/${task.taskId}/side-chat**`, async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const body = method === "GET" ? undefined : request.postDataJSON();
    calls.push({ path, method, body });
    if (unavailable && method === "POST" && path.endsWith("/side-chat")) {
      await route.fulfill({ status: 503, json: { error: "Codex side chat is unavailable." } }); return;
    }
    if (method === "POST" && path.endsWith("/side-chat")) {
      if (!side || side.status === "ended") side = { id: `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`, status: "idle", messages: [], revision: 1, completed: 0 };
    } else if (method === "POST" && path.endsWith("/messages") && side) {
      side = { ...side, status: "running", revision: side.revision + 1, messages: [...side.messages, { id: body.messageId, role: "user", text: body.text }] };
    } else if (method === "POST" && path.endsWith("/stop") && side) side = { ...side, status: "idle", revision: side.revision + 1 };
    else if (method === "DELETE" && side) side = { ...side, status: "ended", revision: side.revision + 1 };
    await route.fulfill({ json: { sideChat: side } });
  });
  let ordinaryMessages = 0;
  await page.route(`**/api/tasks/${task.taskId}/messages`, route => {
    ordinaryMessages++; return route.fulfill({ status: 500, json: { error: "Unexpected main message" } });
  });
  await open(page, task.taskId, { serverHistory: true });
  await send(page, task.taskId, { type: "tasks", tasks: [task], historyThrough: events.length });
  return {
    task, calls, ordinaryMessages: () => ordinaryMessages,
    unavailable: () => { unavailable = true; },
    lost: () => { side = null; },
    complete: () => {
      side = { ...side!, status: "idle", revision: side!.revision + 1, completed: side!.completed + 1,
        messages: [...side!.messages, { id: "answer-" + side!.revision, role: "assistant", text: "The design keeps the main conversation independent." }] };
    },
  };
}
async function show(page: Page, resume = false) {
  await page.getByRole("button", { name: "Task actions", exact: true }).click();
  await page.getByRole("menuitem", { name: resume ? /Resume side chat/ : /^Side chat$/ }).click();
  await expect(page.getByRole("complementary", { name: "Side chat" })).toBeVisible();
}

for (const width of [360, 1280]) test(`side chat lifecycle preserves both drafts and routes actions independently at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 780 });
  const f = await setup(page);
  const main = page.getByRole("textbox", { name: "Message", exact: true });
  await main.fill("Keep my main draft");
  const transcript = page.getByLabel("Session transcript", { exact: true });
  await transcript.hover(); await page.mouse.wheel(0, -600);
  await expect.poll(() => transcript.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeGreaterThan(100);
  const readingPosition = await transcript.evaluate(el => el.scrollTop);
  await show(page);
  const panel = page.getByRole("complementary", { name: "Side chat" });
  const question = panel.getByRole("textbox", { name: "Side question" });
  await expect(question).toBeFocused();
  if (width < 1024) await expect(main).toBeHidden(); else await expect(main).toBeVisible();
  await question.fill("Why this design?");
  await panel.getByRole("button", { name: "Send side question" }).click();
  await expect(panel.getByRole("button", { name: "Stop side response" })).toBeVisible();
  await question.fill("Keep my side draft");
  await panel.getByRole("button", { name: "Back to main chat" }).click();
  await expect(main).toHaveValue("Keep my main draft");
  expect(Math.abs(await transcript.evaluate(el => el.scrollTop) - readingPosition)).toBeLessThan(8);
  await expect(page.getByRole("button", { name: "Task actions", exact: true })).toBeFocused();
  f.complete();
  await expect(page.getByText("Side chat has a new reply", { exact: true })).toHaveCount(1, { timeout: 10_000 });
  await show(page, true);
  await expect(question).toHaveValue("Keep my side draft");
  await expect(panel).toContainText("The design keeps the main conversation independent.");
  if (process.env.SIDE_CHAT_REVIEW_DIR) await page.screenshot({ path: `${process.env.SIDE_CHAT_REVIEW_DIR}/side-chat-${width}.png` });
  await panel.getByRole("button", { name: "Add to draft" }).click();
  await expect(main).toHaveValue("Keep my main draft\n\nThe design keeps the main conversation independent.");
  await expect(main).toBeFocused();
  expect(f.ordinaryMessages()).toBe(0);
  await show(page, true);
  await panel.getByRole("button", { name: "Send side question" }).click();
  await panel.getByRole("button", { name: "Stop side response" }).click();
  await expect(panel.getByRole("button", { name: "Send side question" })).toBeVisible();
  expect(f.calls.filter(call => call.path.endsWith("/stop"))).toHaveLength(1);
  await panel.getByRole("button", { name: "Side chat actions" }).click();
  await page.getByRole("menuitem", { name: "End side chat" }).click();
  await expect(panel.getByText("Side chat ended", { exact: true })).toBeVisible();
  await expect(panel.getByText("Why this design?", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "New side chat" }).click();
  await expect(panel.getByText("Why this design?", { exact: true })).toHaveCount(0);
  await assertViewportLocked(page);
});

test("btw sends only a side question and provider loss keeps the visible conversation", async ({ page }) => {
  const f = await setup(page);
  const main = page.getByRole("textbox", { name: "Message", exact: true });
  await main.fill("/btw Explain the tradeoff");
  await main.press("Control+Enter");
  const panel = page.getByRole("complementary", { name: "Side chat" });
  await expect(panel.getByText("Explain the tradeoff", { exact: true })).toBeVisible();
  expect(f.ordinaryMessages()).toBe(0);
  f.complete();
  await expect(panel).toContainText("The design keeps the main conversation independent.", { timeout: 10_000 });
  f.lost();
  await expect(panel.getByText("Side chat ended", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(panel).toContainText("The design keeps the main conversation independent.");
  await panel.getByRole("button", { name: "Back to main chat" }).click();
  await expect(main).toHaveValue("");
  await expect(main).toBeFocused();
  await show(page);
  await expect(panel.getByText("Side chat ended", { exact: true })).toBeVisible();
  await expect(panel).toContainText("The design keeps the main conversation independent.");
});

test("failed opening keeps the side question editable and main draft intact", async ({ page }) => {
  const f = await setup(page); f.unavailable();
  const main = page.getByRole("textbox", { name: "Message", exact: true });
  await main.fill("Main draft");
  await show(page);
  const panel = page.getByRole("complementary", { name: "Side chat" });
  await expect(panel.getByRole("alert")).toContainText("Codex side chat is unavailable.");
  await panel.getByRole("textbox", { name: "Side question" }).fill("Preserve my question");
  await panel.getByRole("button", { name: "Back to main chat" }).click();
  await expect(main).toHaveValue("Main draft");
  await show(page);
  await expect(panel.getByRole("textbox", { name: "Side question" })).toHaveValue("Preserve my question");
});
