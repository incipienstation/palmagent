import { test, expect, type Page } from "@playwright/test";
import { tasks } from "../fixtures.mjs";
import { assertViewportLocked } from "./_helpers";
import { installScopedStream, send } from "./_session-stream";

test.use({ serviceWorkers: "block" });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const composer = (page: Page) => page.getByRole("group", { name: "Message composer", exact: true });

for (const width of [360, 1280]) test(`first send keeps the conversation and composer mounted at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 780 });
  await installScopedStream(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let request: any;
  const task = { ...tasks.find(t => t.taskId === "t-run")!, prompt: "First message", title: undefined };
  await page.route("**/api/tasks", async route => {
    if (route.request().method() !== "POST") return route.continue();
    request = route.request().postDataJSON(); await gate;
    await route.fulfill({ status: 201, json: { task } });
  });
  await page.route("**/api/tasks/t-run/history*", route => route.fulfill({ json: { events: [], cursor: 0, before: null } }));
  await page.goto("/#/new/space/repo-app");
  await page.getByLabel("Prompt", { exact: true }).fill("First message");
  await page.getByLabel("Attach photos", { exact: true }).setInputFiles({ name: "image.png", mimeType: "image/png", buffer: png });
  await page.screenshot({ path: `/tmp/palmagent-new-chat-draft-${width}.png` });
  const node = await composer(page).elementHandle();
  const input = await composer(page).getByRole("textbox").elementHandle();
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  await expect(page.getByRole("group", { name: "Your message" })).toContainText("First message");
  await expect(page.getByAltText("Attached image 1", { exact: true })).toBeVisible();
  await expect(page.getByText("Working…", { exact: true })).toBeVisible();
  await expect(page.getByText("Creating task…", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  await expect(composer(page).getByRole("textbox")).toHaveValue("");
  await expect.poll(() => composer(page).evaluate(el => el.getBoundingClientRect().height)).toBe(54);
  const pendingBottom = await composer(page).evaluate(el => el.getBoundingClientRect().bottom);
  await page.screenshot({ path: `/tmp/palmagent-new-chat-pending-${width}.png` });
  release();
  await expect(page).toHaveURL(/task\/t-run$/);
  await expect.poll(() => node!.evaluate(el => el === document.querySelector('[aria-label="Message composer"]'))).toBe(true);
  expect(await input!.evaluate(el => el === document.querySelector('textarea'))).toBe(true);
  await expect(page.getByRole("group", { name: "Your message" })).toHaveCount(1);
  await send(page, "t-run", { type: "tasks", tasks: [task], historyThrough: 0 });
  await send(page, "t-run", { type: "event", event: { taskId: "t-run", agent: task.agent, ts: 1, kind: "status",
    payload: { subtype: "dispatch", text: "First message", messageId: request.clientRequestId } } }, 1);
  await expect(page.getByRole("group", { name: "Your message" })).toHaveCount(1);
  await expect(page.getByRole("group", { name: "Your message" })).toContainText("First message");
  expect(await composer(page).evaluate(el => el.getBoundingClientRect().bottom)).toBeCloseTo(pendingBottom, 0);
  await expect(page.getByTestId("toast")).toHaveCount(0);
  await assertViewportLocked(page);
  await page.screenshot({ path: `/tmp/palmagent-new-chat-${width}.png` });
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue("");
  await expect(page.getByRole("group", { name: "Your message" })).toHaveCount(0);
  await expect(page.getByText("What should we work on?", { exact: true })).toBeVisible();
});

test("unknown creation checks its ID before retry and never changes the submitted payload", async ({ page }) => {
  const posts: any[] = []; const checks: string[] = [];
  await page.route("**/api/tasks", route => {
    if (route.request().method() !== "POST") return route.continue();
    posts.push(route.request().postDataJSON());
    return route.fulfill({ status: 503, json: { error: "Response lost" } });
  });
  await page.route(/\/api\/tasks\/t_[^/]+$/, route => {
    checks.push(route.request().url());
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto("/#/new/space/repo-app");
  await page.getByLabel("Prompt", { exact: true }).fill("Keep this request");
  await page.getByLabel("Attach photos", { exact: true }).setInputFiles({ name: "image.png", mimeType: "image/png", buffer: png });
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  await expect(page.getByText("Delivery unconfirmed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(page.getByText("Creation is not confirmed yet.", { exact: false })).toBeVisible();
  expect(posts).toHaveLength(1);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]).toEqual(posts[0]); expect(checks).toHaveLength(2);
  await expect(page.getByRole("group", { name: "Your message" })).toHaveCount(1);
});

test("a lost response reconnects to the created task without another POST", async ({ page }) => {
  let writes = 0; let id = "";
  await page.route("**/api/tasks", route => {
    if (route.request().method() !== "POST") return route.continue();
    writes++; id = route.request().postDataJSON().clientRequestId;
    return route.abort("failed");
  });
  await page.route(/\/api\/tasks\/t_[^/]+$/, route => route.fulfill({ json: { task: { ...tasks.find(t => t.taskId === "t-run"), taskId: `t_${id}` } } }));
  await page.goto("/#/new/space/repo-app");
  await page.getByLabel("Prompt", { exact: true }).fill("Reconnect me");
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`task/t_${id}$`));
  expect(writes).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem("draft:dispatch-prompt:repo-app"))).toBeNull();
});

test("definite rejection offers editing with attachments and settings preserved", async ({ page }) => {
  await page.route("**/api/tasks", route => route.request().method() === "POST"
    ? route.fulfill({ status: 400, json: { error: "Invalid working directory" } }) : route.continue());
  await page.goto("/#/new/space/repo-app");
  await page.getByLabel("Prompt", { exact: true }).fill("Edit after rejection");
  await page.getByLabel("Attach photos", { exact: true }).setInputFiles({ name: "image.png", mimeType: "image/png", buffer: png });
  await page.getByRole("button", { name: "Configure task settings" }).click();
  await page.getByRole("switch", { name: "Isolated worktree" }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  await expect(page.getByText("Not sent", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit message", exact: true }).click();
  await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue("Edit after rejection");
  await expect(page.getByAltText("attachment 1", { exact: true })).toBeVisible();
  await expect(page.getByText("Isolated", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Your message" })).toHaveCount(0);
});

test("reload preserves an unresolved first message and retries the original ID and attachments", async ({ page }) => {
  const requests: any[] = [];
  await page.route("**/api/tasks", route => {
    if (route.request().method() !== "POST") return route.continue();
    requests.push(route.request().postDataJSON());
    return route.fulfill({ status: 503, json: { error: "Connection interrupted" } });
  });
  await page.goto("/#/new/space/repo-app");
  await page.getByLabel("Prompt", { exact: true }).fill("Survive reload");
  await page.getByLabel("Attach photos", { exact: true }).setInputFiles({ name: "image.png", mimeType: "image/png", buffer: png });
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  await expect(page.getByText("Delivery unconfirmed", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("group", { name: "Your message" })).toContainText("Survive reload");
  await expect(page.getByAltText("Attached image 1", { exact: true })).toBeVisible();
  await expect(composer(page).getByRole("textbox")).toBeDisabled();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
});

test("an empty workspace list keeps registration reachable in the compact picker", async ({ page }) => {
  await page.route("**/api/repos", route => route.request().method() === "GET"
    ? route.fulfill({ json: { repos: [] } }) : route.continue());
  await page.goto("/#/new/space/repo-app");
  await page.getByRole("combobox", { name: "Space" }).click();
  await page.getByRole("option", { name: "Add Space", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Add Space", exact: true })).toBeVisible();
  await assertViewportLocked(page);
});

test("slow creation adds a quiet hint while keeping the first message and Stop", async ({ page }) => {
  await page.clock.install();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/tasks", async route => {
    if (route.request().method() !== "POST") return route.continue();
    await pending;
    await route.fulfill({ status: 400, json: { error: "Try again" } });
  });
  await page.goto("/#/new/space/repo-app");
  await page.getByLabel("Prompt", { exact: true }).fill("A slow start");
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  await expect(page.getByText("Preparing conversation…", { exact: true })).toHaveCount(0);
  await page.clock.runFor(8100);
  await expect(page.getByText("Preparing conversation…", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Your message" })).toContainText("A slow start");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  release();
  await expect(page.getByText("Not sent", { exact: true })).toBeVisible();
  await expect(page.getByText("Preparing conversation…", { exact: true })).toHaveCount(0);
});

test("a failed initial history read keeps the accepted first message visible", async ({ page }) => {
  await installScopedStream(page);
  const task = { ...tasks.find(t => t.taskId === "t-run")!, prompt: "Keep the first message", title: undefined };
  await page.route("**/api/tasks", route => route.request().method() === "POST"
    ? route.fulfill({ status: 201, json: { task } }) : route.continue());
  await page.route("**/api/tasks/t-run/history*", route => route.fulfill({ status: 503, json: { error: "History temporarily unavailable" } }));
  await page.goto("/#/new/space/repo-app");
  await page.getByLabel("Prompt", { exact: true }).fill("Keep the first message");
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  await expect(page).toHaveURL(/task\/t-run$/);
  await expect(page.getByRole("alert")).toContainText("History temporarily unavailable");
  await expect(page.getByRole("group", { name: "Your message" })).toHaveCount(1);
  await expect(page.getByRole("group", { name: "Your message" })).toContainText("Keep the first message");
  await expect(page.getByRole("button", { name: "Retry loading conversation", exact: true })).toBeEnabled();
  await expect(composer(page)).toBeInViewport({ ratio: 1 });
});
