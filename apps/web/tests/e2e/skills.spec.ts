import { test, expect, type Page } from "@playwright/test";
import { tasks, repos } from "../fixtures.mjs";
import { installScopedStream, open, send } from "./_scoped-stream";

const palm = { id: "palm-doctor", name: "palmagent:doctor", source: "palmagent", pluginId: "palmagent@palmagent", description: "Check the dispatcher and explain connection problems." };
const project = { id: "project-check", name: "check", source: "repo", description: "Check this project's changes." };
async function catalogue(page: Page) {
  await page.route("**/api/skills?**", route => route.fulfill({ json: { skills: [palm, project] } }));
}

for (const route of ["new", "task/t-idle-rich"]) test(`slash selection is explicit, persisted and restored after failed send (${route})`, async ({ page }) => {
  await catalogue(page);
  const calls: any[] = [];
  await page.route(route === "new" ? "**/api/tasks" : "**/api/tasks/t-idle-rich/messages", async r => {
    calls.push(r.request().postDataJSON()); await r.fulfill({ status: 503, json: { error: "Try again" } });
  });
  await page.goto(`/#/${route}`);
  const input = page.getByRole("textbox", { name: route === "new" ? "Prompt" : "Message", exact: true });
  await input.fill("/doctor");
  await expect(page.getByRole("option", { name: /palmagent:doctor/ })).toBeVisible();
  await expect(input).toBeFocused();
  await input.press("Enter");
  expect(calls).toHaveLength(0);
  await expect(input).toHaveValue("");
  await expect(page.getByLabel("Selected skills").getByAltText("Palmagent plugin")).toBeVisible();
  await input.fill("Check HTTPS");
  await page.reload();
  await expect(page.getByRole("button", { name: "Remove palmagent:doctor skill" })).toBeVisible();
  await expect(input).toHaveValue("Check HTTPS");
  await input.press("Control+Enter");
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0].skills).toEqual([{ id: palm.id, name: palm.name, source: palm.source, pluginId: palm.pluginId }]);
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("Check HTTPS");
  await expect(page.getByRole("button", { name: "Remove palmagent:doctor skill" })).toBeVisible();
});

test("slash picker protects IME, Enter, literal paths and Escape; button works on touch", async ({ page }) => {
  await catalogue(page);
  let sends = 0;
  await page.route("**/api/tasks", async r => { sends++; await r.fulfill({ status: 503, json: { error: "Try again" } }); });
  await page.goto("/#/new");
  const input = page.getByRole("textbox", { name: "Prompt", exact: true });
  for (const literal of ["https://example.com/a", "./src", "/usr/local/bin", "text/path"]) {
    await input.fill(literal); await expect(page.getByRole("listbox", { name: "Available skills" })).toHaveCount(0);
  }
  await input.fill("/");
  await expect(page.getByRole("option")).toHaveCount(2);
  await input.dispatchEvent("compositionstart");
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, isComposing: true });
  expect(sends).toBe(0); await expect(page.getByRole("option")).toHaveCount(2);
  await input.dispatchEvent("compositionend");
  await input.press("Escape"); await expect(input).toHaveValue("/");
  await expect(page.getByRole("listbox", { name: "Available skills" })).toHaveCount(0);
  await input.fill("Check this ");
  await page.getByRole("button", { name: "Choose a skill" }).tap();
  await expect(page.getByRole("option")).toHaveCount(2);
  await page.getByRole("option", { name: /palmagent:doctor/ }).tap();
  await expect(input).toHaveValue("Check this "); expect(sends).toBe(0);
  await page.getByRole("button", { name: "Remove palmagent:doctor skill" }).tap();
  await expect(page.getByLabel("Selected skills")).toHaveCount(0);
});

test("loading failure is retryable and an unmatched slash never submits on Enter", async ({ page }) => {
  let attempts = 0, sends = 0;
  await page.route("**/api/skills?**", r => { attempts++; return r.fulfill(attempts === 1 ? { status: 503, json: { error: "Agent unavailable" } } : { json: { skills: [palm] } }); });
  await page.route("**/api/tasks", r => { sends++; return r.fulfill({ status: 503, json: { error: "Try again" } }); });
  await page.goto("/#/new");
  const input = page.getByRole("textbox", { name: "Prompt", exact: true });
  await input.fill("/missing");
  await expect(page.getByRole("alert")).toHaveText("Agent unavailable");
  await input.press("Control+Enter"); expect(sends).toBe(0);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText("No matching skills in this environment.")).toBeVisible();
  await input.press("Enter"); expect(sends).toBe(0);
});

test("queue editing keeps skill selection and transcript displays the source logo", async ({ page }) => {
  await catalogue(page); await installScopedStream(page);
  const state = { revision: 1, paused: true, runId: "run-1", messages: [{ id: "queued-skill", version: 1, mode: "queue", text: "Check service", skills: [palm], status: "queued", editingUntil: undefined as number | undefined }] };
  const calls: any[] = [];
  await page.route("**/api/tasks/t-run/messages/**", async r => {
    const body = r.request().postDataJSON(); calls.push(body);
    if (body.action === "edit" || body.action === "renew") state.messages[0].editingUntil = Date.now() + 60000;
    if (body.action === "save") { state.messages[0].text = body.text; state.messages[0].skills = body.skills; state.messages[0].version++; state.messages[0].editingUntil = undefined; }
    state.revision++; await r.fulfill({ json: state });
  });
  await open(page, "t-run");
  await send(page, "t-run", { type: "tasks", tasks: [{ ...tasks.find(t => t.taskId === "t-run")!, messageQueue: state }], replayThrough: 0 });
  await page.getByRole("button", { name: /Queued message 1:/ }).click({ button: "right" });
  await page.getByRole("button", { name: "Edit prompt", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove palmagent:doctor skill" })).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("Check again");
  await page.getByRole("button", { name: "Save queued message" }).click();
  expect(calls.find(c => c.action === "save").skills[0].id).toBe(palm.id);
  await send(page, "t-run", { type: "event", event: { id: 10001, taskId: "t-run", agent: "codex", ts: Date.now(), kind: "status", payload: { subtype: "steer", text: "Check service", skills: [palm] } } }, 10001);
  await expect(page.getByAltText("Palmagent plugin")).toBeVisible();
});

for (const theme of ["light", "dark"]) for (const width of [360, 1280]) test(`picker fits ${width}px in ${theme} mode`, async ({ page }) => {
  await page.setViewportSize({ width, height: 850 });
  await catalogue(page);
  await page.goto(`/?__theme=${theme}#/new`);
  await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("/");
  const menu = page.getByRole("listbox", { name: "Available skills" });
  await expect(menu).toBeVisible();
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `/tmp/palmagent-skills-${width}-${theme}.png` });
});


test("typing slash before repository discovery completes opens the correct catalogue", async ({ page }) => {
  await catalogue(page);
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/repos", async route => { await ready; await route.fulfill({ json: { repos } }); });
  await page.goto("/#/new");
  const input = page.getByRole("textbox", { name: "Prompt", exact: true });
  await input.fill("/doctor");
  await expect(page.getByRole("option")).toHaveCount(0);
  release();
  await expect(page.getByRole("option", { name: /palmagent:doctor/ })).toBeVisible();
  await expect(input).toBeFocused();
});
