import { test as base, expect, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONVERSATION_PAGE_BYTES, type AgentEvent, type TaskState } from "@palmagent/shared";
import { openDatabase } from "../../../server/src/platform/sqlite/connection";
import { SqliteSpaces } from "../../../server/src/modules/spaces/adapters/outbound/sqlite-spaces";
import { SqliteTasks } from "../../../server/src/modules/tasks/adapters/outbound/sqlite-tasks";
import { installScopedStream, send, viewport, expectBottom } from "./_session-stream";

const taskId = "t-idle-rich";
const event = (kind: AgentEvent["kind"], payload: unknown) => ({ taskId, agent: "codex", kind, payload, ts: 1 } as AgentEvent);
const message = (text: string, id = text) => event("assistant_text", { text, messageId: id, phase: "final" });
const user = (text: string) => event("status", { subtype: "followup", text });
function gate() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); return { wait, release }; }

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "palmagent-conversation-browser-"));
  const db = openDatabase(join(directory, "history.sqlite"));
  const spaces = new SqliteSpaces(db), tasks = new SqliteTasks(db);
  spaces.insertRepo({ id: "space", name: "Fixture", path: directory, vcs: "none", defaultBaseRef: "", createdAt: 1 });
  const task: TaskState = { taskId, repoId: "space", agent: "codex", prompt: "Fixture", status: "idle", interrupted: false,
    permission: "default", createdAt: 1, updatedAt: 1, lastActivityAt: 1 };
  tasks.insertTask(task);
  return { tasks, task, add: (events: AgentEvent[]) => tasks.appendAgentEvents(taskId, events),
    close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}
type History = ReturnType<typeof fixture>;
const test = base.extend<{ history: History }>({ history: async ({}, use) => {
  const history = fixture(); try { await use(history); } finally { history.close(); }
} });
test.use({ serviceWorkers: "block" });

async function routes(page: Page, history: History, older?: ReturnType<typeof gate>) {
  await page.addInitScript(() => localStorage.setItem("pref:output-mode", "compact"));
  await installScopedStream(page);
  const reads: Array<{ before: number | null; count: number; bytes: number }> = [], details: number[] = [], changes: number[] = [], content: number[] = [];
  await page.route(new RegExp(`/api/tasks/${taskId}/history(?:\\?.*)?$`), async route => {
    const q = new URL(route.request().url()).searchParams;
    expect(q.get("format")).toBe("transcript");
    const before = q.has("before") ? Number(q.get("before")) : undefined;
    const response = history.tasks.conversationPage(taskId, before);
    reads.push({ before: before ?? null, count: response.transcript!.length, bytes: Buffer.byteLength(JSON.stringify(response)) });
    if (before && older) await older.wait;
    await route.fulfill({ json: response });
  });
  await page.route(new RegExp(`/api/tasks/${taskId}/history/changes(?:\\?.*)?$`), async route => {
    const q = new URL(route.request().url()).searchParams;
    expect(q.get("format")).toBe("transcript");
    const response = history.tasks.conversationChanges(taskId, Number(q.get("after")), Number(q.get("through")), q.has("afterKey") ? Number(q.get("afterKey")) : undefined);
    changes.push(Buffer.byteLength(JSON.stringify(response)));
    await route.fulfill({ json: response });
  });
  await page.route(new RegExp(`/api/tasks/${taskId}/history/steps(?:\\?.*)?$`), async route => {
    const q = new URL(route.request().url()).searchParams;
    const response = history.tasks.conversationSteps(taskId, Number(q.get("key")), Number(q.get("after") ?? 0));
    details.push(response.steps.length);
    await route.fulfill({ json: response });
  });
  await page.route(new RegExp(`/api/tasks/${taskId}/history/step-details(?:\\?.*)?$`), async route => {
    const q = new URL(route.request().url()).searchParams;
    await route.fulfill({ json: history.tasks.conversationStepDetails(taskId, Number(q.get("key")), Number(q.get("step")), Number(q.get("after") ?? 0)) });
  });
  await page.route(new RegExp(`/api/tasks/${taskId}/history/items(?:\\?.*)?$`), async route => {
    const q = new URL(route.request().url()).searchParams;
    const response = history.tasks.conversationDetails(taskId, Number(q.get("key")), Number(q.get("after") ?? 0));
    details.push(response.items.length);
    await route.fulfill({ json: response });
  });
  await page.route(new RegExp(`/api/tasks/${taskId}/history/content(?:\\?.*)?$`), async route => {
    const q = new URL(route.request().url()).searchParams;
    const response = history.tasks.conversationContent(taskId, Number(q.get("key")), q.get("version")!, Number(q.get("offset")), q.has("member") ? Number(q.get("member")) : undefined);
    content.push(Buffer.byteLength(JSON.stringify(response)));
    await route.fulfill({ json: response });
  });
  return { reads, details, changes, content };
}

test("Compact first loads 30 display records and retains the reader during prepend and live replacement", async ({ page, history }) => {
  history.add(Array.from({ length: 100 }, (_, i) => [user(`Question ${i}`), message(`Answer ${i}\n\n${"A paragraph long enough to measure the reader position.\n\n".repeat(6)}`, `answer-${i}`)]).flat());
  const pending = gate(), requests = await routes(page, history, pending);
  await page.goto(`/#/task/${taskId}`);
  await expect(page.getByText("Answer 99", { exact: true })).toBeVisible();
  await expectBottom(page);
  expect(requests.reads).toHaveLength(1);
  expect(requests.reads[0].count).toBe(30);
  expect(requests.reads[0].bytes).toBeLessThanOrEqual(CONVERSATION_PAGE_BYTES);
  await viewport(page).evaluate(el => { el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })); el.scrollTop = 0; });
  await expect.poll(() => requests.reads.length).toBe(2);
  const anchor = page.locator('[data-message-key="171"]');
  await expect(anchor).toBeVisible();
  const top = (await anchor.boundingBox())!.y;
  history.add([message("\n\nLive replacement arrived", "answer-99")]);
  await send(page, taskId, { type: "history-change", taskId, through: history.tasks.eventCursor(taskId) });
  await expect.poll(() => requests.changes.length).toBeGreaterThan(0);
  pending.release();
  await expect(page.getByText("Loading earlier messages…", { exact: true })).toHaveCount(0);
  await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - top)).toBeLessThanOrEqual(2);
  await page.getByRole("button", { name: "Scroll to bottom", exact: true }).click();
  await expect(page.getByText("Live replacement arrived", { exact: true })).toBeVisible();
  await expect(page.locator('[data-message-key="199"]')).toHaveCount(1);
  await expect(page.locator('[data-message-key="200"]')).toHaveCount(1);
  await expect(page.getByRole("status", { name: "Loading conversation", exact: true })).toHaveCount(0);
});

test("Activity summary stays complete while operation summaries load in explicit pages", async ({ page, history }) => {
  history.add([user("Inspect files"), ...Array.from({ length: 400 }, (_, i) => [
    event("tool_call", { id: `tool-${i}`, name: "Read", input: { path: `fixture-${i}.txt` } }),
    event("tool_result", { tool_use_id: `tool-${i}`, output: `Detail result ${i}` }),
  ]).flat(), message("Inspection finished")]);
  const requests = await routes(page, history);
  let failedDetails = false;
  await page.route(new RegExp(`/api/tasks/${taskId}/history/steps(?:\\?.*)?$`), async route => {
    if (!failedDetails) { failedDetails = true; await route.abort(); } else await route.fallback();
  });
  await page.goto(`/#/task/${taskId}`);
  const activity = page.getByRole("button", { name: "Activity · 400 tools", exact: true });
  await expect(activity).toBeVisible(); expect(requests.details).toEqual([]);
  await activity.focus(); await page.keyboard.press("Enter");
  await expect(page.getByText("Couldn’t load details.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("button", { name: "Completed: Read fixture-0.txt", exact: true })).toBeVisible();
  expect(requests.details).toEqual([50]);
  await expect(page.getByText("Detail result 0", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Completed: Read fixture-0.txt", exact: true }).click();
  await expect(page.getByText("Detail result 0", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Load more steps", exact: true }).click();
  await expect(page.getByRole("button", { name: "Completed: Read fixture-99.txt", exact: true })).toBeVisible();
  await expect(page.getByText("Detail result 99", { exact: false })).toHaveCount(0);
  expect(requests.details).toEqual([50, 50]);
  await expect(activity).toHaveAttribute("aria-expanded", "true"); expect(requests.reads).toHaveLength(1);
});

test("oversized content is explicitly loaded through bounded chunks", async ({ page, history }) => {
  history.add([user("Read a long message"), message(`Beginning\n\n${"Long Unicode 😀 paragraph.\n\n".repeat(3000)}End of full message`)]);
  const requests = await routes(page, history);
  await page.goto(`/#/task/${taskId}`);
  const load = page.getByRole("button", { name: "Load full message", exact: true });
  await expect(load).toBeVisible();
  expect(requests.content).toHaveLength(0);
  expect(requests.reads[0].bytes).toBeLessThanOrEqual(CONVERSATION_PAGE_BYTES);
  await load.click();
  await expect(load).toHaveCount(0);
  await expect(page.getByText("End of full message", { exact: true })).toHaveCount(1);
  expect(requests.content.length).toBeGreaterThan(1);
  expect(Math.max(...requests.content)).toBeLessThanOrEqual(CONVERSATION_PAGE_BYTES);
});

test("late classification and tool completion retry a partial revision without hiding prose", async ({ page, history }) => {
  history.add(Array.from({ length: 45 }, (_, i) => [event("tool_call", { id: `tool-${i}`, name: "Read" }),
    event("assistant_text", { text: `Unclassified message ${i}`, messageId: `m-${i}` })]).flat());
  const requests = await routes(page, history);
  let changeAttempts = 0;
  await page.route(new RegExp(`/api/tasks/${taskId}/history/changes(?:\\?.*)?$`), async route => {
    if (++changeAttempts === 2) await route.abort(); else await route.fallback();
  });
  await page.goto(`/#/task/${taskId}`);
  await expect(page.getByText("Unclassified message 44", { exact: true })).toBeVisible();
  history.add(Array.from({ length: 45 }, (_, i) => [event("status", { subtype: "assistant_message", messageId: `m-${i}`, phase: "progress" }),
    event("tool_result", { tool_use_id: `tool-${i}`, output: "Done", exit_code: 0 })]).flat());
  await send(page, taskId, { type: "history-change", taskId, through: history.tasks.eventCursor(taskId) });
  await expect(page.getByText("Unclassified message 44", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Activity · 45 tools", exact: true })).toHaveCount(0);
  await expect.poll(() => requests.changes.length).toBeGreaterThanOrEqual(3);
  expect(changeAttempts).toBeGreaterThanOrEqual(4);
  expect(Math.max(...requests.changes)).toBeLessThanOrEqual(CONVERSATION_PAGE_BYTES);
});

for (const mode of ["compact", "verbose"] as const) test(`a projected checkpoint restores correctly in ${mode} mode`, async ({ page, history }) => {
  history.add([user("Checkpoint request"), event("tool_call", { id: "one", name: "Read" }),
    event("tool_result", { tool_use_id: "one", output: "Checkpoint tool detail" }), message("Checkpoint answer")]);
  const snapshot = history.tasks.conversationPage(taskId);
  await installScopedStream(page);
  await page.addInitScript(mode => localStorage.setItem("pref:output-mode", mode), mode);
  let reads = 0;
  await page.route(new RegExp(`/api/tasks/${taskId}/history(?:\\?.*)?$`), route => {
    reads++;
    expect(new URL(route.request().url()).searchParams.has("format")).toBe(false);
    return route.fulfill({ json: { events: history.tasks.eventsAfterSeq(taskId, 0), before: null, cursor: snapshot.cursor } });
  });
  await page.goto("/#/spaces");
  await page.evaluate(async ({ taskId, snapshot }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("palmagent-screen-state", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("checkpoints");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("checkpoints", "readwrite");
        tx.objectStore("checkpoints").put({ route: `#/task/${taskId}`, created: Date.now(), screen: { scroll: [] }, values: {
          [`history:${taskId}`]: { pages: [{ ...snapshot, items: snapshot.transcript!.flatMap(row => row.type === "message" ? [row.item] : row.items) }], pageParams: [null] },
        } }, "projected-checkpoint");
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
      });
      sessionStorage.setItem("palmagent:screen-checkpoint", "projected-checkpoint");
    } finally { db.close(); }
  }, { taskId, snapshot });
  await page.goto(`/?checkpoint=projected#/task/${taskId}`);
  await expect(page.getByText("Checkpoint answer", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Activity · 1 tool", exact: true })).toBeVisible();
  await expect(page.getByText("Checkpoint tool detail", { exact: false })).toHaveCount(0);
  expect(reads).toBe(0);
});
