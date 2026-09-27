import { test, expect, type Page } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";

const title = "Wire the web QA harness";
const path = "/api/tasks/t-idle-rich/pin";
async function toggle(page: Page, label: string, action: "Pin" | "Unpin") {
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}

test.afterEach(async ({ request }) => {
  await request.patch(path, { data: { pinned: false } });
  await request.patch("/api/tasks/t-idle-interrupted/pin", { data: { pinned: false } });
});

for (const width of [360, 1280]) test(`pin syncs list, detail and navigation at ${width}px and survives reload`, async ({ page, context }) => {
  await page.setViewportSize({ width, height: 780 });
  await page.goto("/");
  const other = await context.newPage();
  await other.goto("/#/task/t-idle-rich");
  await expect(other.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await toggle(page, `Actions for ${title}`, "Pin");
  await expect(page.getByRole("img", { name: "Pinned", exact: true })).toHaveCount(1);
  await other.getByRole("button", { name: "Task actions", exact: true }).click();
  await expect(other.getByRole("menuitem", { name: "Unpin", exact: true })).toBeVisible();
  await other.keyboard.press("Escape");
  await page.reload();
  await page.getByRole("button", { name: "Open navigation" }).click();
  const pinned = page.getByRole("region", { name: "Pinned", exact: true });
  await expect(pinned.getByRole("button", { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("button", { name: title, exact: true })).toHaveCount(1);
  await assertViewportLocked(page);
  await pinned.getByRole("button", { name: title, exact: true }).click();
  await expect(page).toHaveURL(/task\/t-idle-rich$/);
  await toggle(other, "Task actions", "Unpin");
  await page.getByRole("button", { name: "Task actions", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Pin", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(pinned).toHaveCount(0);
  await expect(page.getByRole("dialog").getByRole("button", { name: title, exact: true })).toBeVisible();
});

test("failed pin rolls back and blocks duplicate requests while pending", async ({ page }) => {
  await page.goto("/#/task/t-idle-rich");
  let release: () => void = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  await page.route(`**${path}`, async route => {
    requests++;
    await pending;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Try again." }) });
  });
  await toggle(page, "Task actions", "Pin");
  await page.getByRole("button", { name: "Task actions", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Unpin", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  expect(requests).toBe(1);
  release();
  await expect(page.getByText("Couldn't update this pin", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Task actions", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Pin", exact: true })).toBeEnabled();
});


test("pins keep creation order within their status group and respect search and Space filters", async ({ page, request }) => {
  await page.goto("/");
  await request.patch("/api/tasks/t-idle-interrupted/pin", { data: { pinned: true } });
  await request.patch(path, { data: { pinned: true } });
  const done = page.locator("section").filter({ has: page.getByRole("heading", { name: "Done", exact: true }) });
  await expect(done.getByRole("button", { name: /^Actions for / }).nth(0)).toHaveAccessibleName("Actions for Interrupted across a deploy");
  await expect(done.getByRole("button", { name: /^Actions for / }).nth(1)).toHaveAccessibleName(`Actions for ${title}`);
  await page.getByRole("button", { name: "Open navigation" }).click();
  const pinned = page.getByRole("region", { name: "Pinned", exact: true });
  await expect(pinned.getByRole("button").nth(0)).toHaveText("Interrupted across a deploy");
  await expect(pinned.getByRole("button").nth(1)).toHaveText(title);
  await page.getByRole("button", { name: "Close navigation" }).click();
  await page.getByRole("searchbox", { name: "Search tasks" }).fill("Wire the web");
  await expect(page.getByRole("button", { name: /^Actions for / })).toHaveCount(1);
  await page.getByRole("searchbox", { name: "Search tasks" }).fill("");
  await page.getByRole("button", { name: /^Switch space:/ }).click();
  await page.getByRole("dialog", { name: "Spaces", exact: true }).locator('button[title="/projects/notes"]').click();
  await expect(page.getByRole("button", { name: `Actions for ${title}`, exact: true })).toHaveCount(0);
  await expect(page.getByRole("img", { name: "Pinned", exact: true })).toHaveCount(0);
});
