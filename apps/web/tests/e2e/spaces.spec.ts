import { test, expect, type Page } from "@playwright/test";
import { repos, tasks } from "../fixtures.mjs";
import { assertViewportLocked } from "./_helpers";

test.use({ serviceWorkers: "block" });
const fixtureRepos = [
  { ...repos[0], id: "main", name: "Palmagent", path: "/spaces/customer-experience/palmagent" },
  { ...repos[0], id: "other", name: "Palmagent", path: "/spaces/experiments/palmagent" },
  { ...repos[0], id: "long", name: "a-very-long-space-name-that-must-never-widen-the-phone-screen", path: "/spaces/long-space" },
];
const fixtureTasks = [
  { ...tasks[0], taskId: "main-task", repoId: "main", title: "Review Space navigation", branch: undefined, worktreePath: undefined },
  { ...tasks[0], taskId: "work", repoId: "main", title: "Worktree task", branch: "feature/navigation", worktreePath: "/spaces/customer-experience/palmagent/.worktrees/navigation" },
  { ...tasks[0], taskId: "other-task", repoId: "other", title: "Separate Space task", branch: undefined, worktreePath: undefined },
];
async function setup(page: Page, path = "/") {
  await page.route("**/api/repos", route => route.fulfill({ json: { repos: fixtureRepos } }));
  await page.route("**/api/stream*", route => route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "tasks", tasks: fixtureTasks })}\n\n` }));
  await page.goto(path);
}
const mainSpace = (page: Page) => page.getByRole("region", { name: "Spaces list" }).getByRole("button", { name: /customer-experience/ });

test("All spaces ignores legacy filters and Spaces has searchable, distinct rows", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.addInitScript(() => localStorage.setItem("working-directory", "/missing/old-worktree"));
  await setup(page);
  await expect(page.getByRole("heading", { name: /^All spaces(?: Reconnecting…)?$/, level: 1 })).toBeVisible();
  await expect(page.getByText("Separate Space task", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open Spaces" }).click();
  await expect(page).toHaveURL(/#\/spaces$/);
  const search = page.getByRole("searchbox", { name: "Search Spaces" });
  await expect(search).not.toBeFocused();
  await expect(page.getByRole("region", { name: "Spaces list" }).getByRole("button")).toHaveCount(3);
  await expect(page.getByText(fixtureRepos[0].path, { exact: true })).toHaveCount(0);
  await search.fill("experiments");
  await expect(page.getByRole("region", { name: "Spaces list" }).getByRole("button")).toHaveCount(1);
  await search.fill("not-found");
  await expect(page.getByText("No Spaces found", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /All spaces.*Tasks across/ }).click();
  await expect(page.getByText("Separate Space task", { exact: true })).toBeVisible();
  await assertViewportLocked(page);
});

test("Space scope survives reload and search is restored when returning to the list", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "Open Spaces" }).click();
  await mainSpace(page).click();
  await expect(page.getByText("Worktree task", { exact: true })).toBeVisible();
  await expect(page.getByText("Separate Space task", { exact: true })).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search tasks" }).fill("Worktree");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await mainSpace(page).click();
  await expect(page.getByRole("searchbox", { name: "Search tasks" })).toHaveValue("Worktree");
  await page.reload();
  await expect(page.getByRole("heading", { name: /^Palmagent/, level: 1 })).toBeVisible();
  await expect(page.getByText("Separate Space task", { exact: true })).toHaveCount(0);
});

test("Worktree filters stay within a Space and new tasks have an explicit target", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pref:dispatch-repo", "other"));
  await setup(page, "/#/spaces/main");
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Task filters" });
  await expect(dialog.getByRole("button", { name: "Close filters" })).toBeFocused();
  await dialog.getByRole("combobox", { name: "Worktree" }).click();
  await page.getByRole("option", { name: "feature/navigation", exact: true }).click();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("button", { name: "Clear Worktree filter" })).toContainText("feature/navigation");
  await expect(page.getByText("Review Space navigation", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Dispatch new task" }).click();
  await expect(page).toHaveURL(/#\/new\/space\/main$/);
  await expect(page.getByRole("combobox", { name: "Space", exact: true })).toContainText("customer-experience");
  await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("Preserve this draft");
  await page.getByRole("combobox", { name: "Space", exact: true }).click();
  await page.getByRole("option", { name: /experiments/ }).click();
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("Preserve this draft");
  expect(await page.evaluate(() => localStorage.getItem("working-directory"))).toBeNull();
});

test("Space information owns full paths and explicit terminal scope", async ({ page }) => {
  const queries: string[] = [];
  await page.route("**/api/terminals*", route => {
    queries.push(new URL(route.request().url()).searchParams.get("repoId") ?? "all");
    return route.fulfill({ json: { terminals: [], capabilities: { available: true, persistent: true } } });
  });
  await setup(page, "/#/spaces/main");
  await page.getByRole("button", { name: "Space details" }).click();
  const dialog = page.getByRole("dialog", { name: "Palmagent" });
  await expect(dialog.getByText(fixtureRepos[0].path, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Terminals", exact: true }).click();
  await expect(page).toHaveURL(/#\/terminals\/repo\/main$/);
  await expect.poll(() => queries.includes("main")).toBe(true);
});

test("desktop uses one rail and empty, long-name Spaces fit a narrow phone", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await setup(page, "/#/spaces");
  await expect(page.getByRole("complementary", { name: "Space navigation" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCount(1);
  await page.getByRole("region", { name: "Spaces list" }).getByRole("button", { name: /a-very-long-space/ }).click();
  await expect(page.getByText("No tasks yet", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 780 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(1);
  await assertViewportLocked(page);
  await expect(page.getByRole("button", { name: "Dispatch new task" })).toBeEnabled();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await assertViewportLocked(page);
});

test("missing Space cannot silently fall back to another execution target", async ({ page }) => {
  await setup(page, "/#/spaces/missing");
  await expect(page.getByText(/This Space is no longer connected/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Dispatch new task" })).toBeDisabled();
  await page.goto("/#/new/space/missing");
  await expect(page.getByRole("combobox", { name: "Space", exact: true })).toHaveText(/Choose a Space/);
});

test("neutral new tasks require a Space, then preserve the unassigned draft", async ({ page }) => {
  await setup(page, "/#/new");
  await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("Choose the target explicitly");
  await expect(page.getByRole("button", { name: "Send now", exact: true })).toBeDisabled();
  await page.getByRole("combobox", { name: "Space", exact: true }).click();
  await page.getByRole("option", { name: /customer-experience/ }).click();
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("Choose the target explicitly");
  await expect(page.getByRole("button", { name: "Send now", exact: true })).toBeEnabled();
});

test("Space drafts restore separately and switching cannot overwrite a saved draft without a choice", async ({ page }) => {
  await setup(page, "/#/new/space/main");
  await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("Main draft");
  await page.goto("/#/new/space/other");
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("");
  await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("Other draft");
  await page.getByRole("combobox", { name: "Space", exact: true }).click();
  await page.getByRole("option", { name: /customer-experience/ }).click();
  await expect(page.getByRole("dialog", { name: "A draft is already saved in this Space" })).toBeVisible();
  await page.getByRole("button", { name: "Open saved draft", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("Main draft");
  await page.goto("/#/new/space/other");
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("Other draft");
});

test("switching Spaces retains attachments and requires a choice before replacing a draft", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("draft:dispatch-prompt:other", "Saved target draft"));
  await setup(page, "/#/new/space/main");
  await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("Draft with an image");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add attachments" }).click();
  await page.getByRole("menuitem", { name: "Photos" }).click();
  await (await chooser).setFiles({ name: "draft.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64") });
  await expect(page.getByAltText("attachment 1")).toBeVisible();
  await page.getByRole("combobox", { name: "Space", exact: true }).click();
  await page.getByRole("option", { name: /experiments/ }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(/#\/new\/space\/main$/);
  await expect(page.getByAltText("attachment 1")).toBeVisible();
  await page.getByRole("combobox", { name: "Space", exact: true }).click();
  await page.getByRole("option", { name: /experiments/ }).click();
  await page.getByRole("button", { name: "Replace saved draft with current draft", exact: true }).click();
  await expect(page).toHaveURL(/#\/new\/space\/other$/);
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("Draft with an image");
  await expect(page.getByAltText("attachment 1")).toBeVisible();
  await page.goto("/#/new/space/main");
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("Draft with an image");
  await expect(page.getByAltText("attachment 1")).toBeVisible();
});

test("a pre-Spaces update checkpoint restores the prompt and attached image together", async ({ page }) => {
  await setup(page, "/#/new");
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("palmagent-screen-state", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("checkpoints");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("checkpoints", "readwrite");
      tx.objectStore("checkpoints").put({ route: "#/new", created: Date.now(), screen: { scroll: [] }, values: {
        "pref:dispatch-repo": "main",
        "draft:dispatch-prompt": "Draft from before Spaces",
        "images:#/new": [{ mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", width: 1, height: 1 }],
      } }, "legacy-space-draft");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    sessionStorage.setItem("palmagent:screen-checkpoint", "legacy-space-draft");
  });
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Space", exact: true })).toContainText("customer-experience");
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("Draft from before Spaces");
  await expect(page.getByAltText("attachment 1")).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("draft:dispatch-prompt"))).toBeNull();
});

for (const width of [320, 360]) test(`mobile search stays reachable below the list and above the keyboard at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 780 });
  await setup(page, "/#/spaces");
  const search = page.getByRole("searchbox", { name: "Search Spaces" });
  const form = page.getByRole("search", { name: "Find a Space" });
  await expect(search).not.toBeFocused();
  await expect.poll(async () => (await search.boundingBox())!.y).toBeGreaterThan(690);
  await search.tap();
  await search.fill("experiments");
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, "height", { configurable: true, value: 420 });
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  await expect.poll(async () => { const r = (await form.boundingBox())!; return r.y + r.height; }).toBeLessThanOrEqual(420);
  await expect(search).toBeFocused();
  await expect(page.getByRole("region", { name: "Spaces list" }).getByRole("button")).toHaveCount(1);
  const clear = page.getByRole("button", { name: "Clear Space search" });
  await expect(clear).toBeInViewport({ ratio: 1 });
  await clear.tap();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await page.getByRole("button", { name: "Close Space search" }).tap();
  await expect(search).not.toBeFocused();
  const last = page.getByRole("region", { name: "Spaces list" }).getByRole("button").last();
  await last.scrollIntoViewIfNeeded();
  await expect.poll(async () => { const row = (await last.boundingBox())!; return row.y + row.height - (await form.boundingBox())!.y; }).toBeLessThanOrEqual(1);
  await search.tap();
  await search.fill("Palmagent");
  await search.press("Enter");
  await expect(search).toHaveValue("Palmagent");
  await expect(search).not.toBeFocused();
  await page.setViewportSize({ width, height: 420 });
  await assertViewportLocked(page);
});

test("desktop search stays above the list and resizing preserves the same query and input", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await setup(page, "/#/spaces");
  const search = page.getByRole("searchbox", { name: "Search Spaces" });
  const all = page.getByRole("button", { name: /All spaces.*Tasks across/ });
  const box = (await search.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual((await all.boundingBox())!.y);
  await search.fill("experiments");
  await page.setViewportSize({ width: 360, height: 780 });
  await expect(search).toHaveCount(1);
  await expect(search).toHaveValue("experiments");
  await expect.poll(async () => (await search.boundingBox())!.y).toBeGreaterThan(690);
  await search.press("Escape");
  await expect(search).toHaveValue("experiments");
  await expect(search).not.toBeFocused();
  await assertViewportLocked(page);
});

for (const layout of [false, true]) for (const query of ["", "experiments", "   "]) test(`Space search preserves its query on keyboard dismissal (${layout ? "Android" : "Safari"}, ${JSON.stringify(query)})`, async ({ page }) => {
  await setup(page, "/#/spaces");
  const search = page.getByRole("searchbox", { name: "Search Spaces" });
  await search.fill(query);
  const viewport = async (height: number) => page.evaluate(({ height, layout }) => {
    if (layout) Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
    Object.defineProperty(window.visualViewport, "height", { configurable: true, value: height });
    window.visualViewport!.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
  }, { height, layout });
  await viewport(730); await viewport(780);
  await expect(search).toBeFocused();
  await viewport(480);
  await expect(search).toBeFocused();
  await viewport(780);
  await expect(search).not.toBeFocused();
  await expect(search).toHaveValue(query);
  await expect(page.getByRole("button", { name: "Close Space search" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Clear Space search" })).toHaveCount(query.trim() ? 1 : 0);
  await search.focus();
  await expect(search).toBeFocused();
});

test("Space search clearing keeps editing active and closing preserves filters", async ({ page }) => {
  await setup(page, "/#/spaces");
  const search = page.getByRole("searchbox", { name: "Search Spaces" });
  await search.fill("not-found");
  await page.getByRole("button", { name: "Clear search", exact: true }).tap();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await search.fill("experiments");
  await search.press("Enter");
  await expect(search).not.toBeFocused();
  await expect(search).toHaveValue("experiments");
  await page.getByRole("button", { name: "Clear Space search" }).tap();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await search.press("Tab");
  await expect(page.getByRole("button", { name: "Close Space search" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Close Space search" })).toHaveCount(0);
  await expect(search).not.toBeFocused();
});
