import { test, expect, type Page } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";

const original = "Wire the web QA harness";
const path = "/api/tasks/t-idle-rich";

async function openRename(page: Page, label: string) {
  const trigger = page.getByRole("button", { name: label, exact: true });
  await trigger.click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Rename session" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Session name" })).toBeFocused();
  return trigger;
}

test.afterEach(async ({ request }) => {
  await request.patch(path, { data: { title: original } });
});

test("list rename updates another open detail and survives reload without changing order", async ({ page, context }) => {
  await page.goto("/");
  const other = await context.newPage();
  await other.goto("/#/task/t-idle-rich");
  await expect(other.getByRole("heading", { name: original, exact: true })).toBeVisible();
  const order = () => page.getByRole("button", { name: /^Actions for / }).evaluateAll((items) => items.map((el) => el.getAttribute("aria-label")));
  const before = await order();
  await expect(page.locator('button button[aria-label^="Actions for "]')).toHaveCount(0);
  await openRename(page, `Actions for ${original}`);
  const input = page.getByRole("textbox", { name: "Session name" });
  await expect(input).toHaveValue(original);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await input.fill("   ");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await input.fill("  로그인 오류 조사  ");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("button", { name: "Actions for 로그인 오류 조사", exact: true })).toBeFocused();
  await expect(other.getByRole("heading", { name: "로그인 오류 조사", exact: true })).toBeVisible();
  await expect(other).toHaveTitle("로그인 오류 조사 · PalmAgent");
  expect((await order()).map((name) => name === "Actions for 로그인 오류 조사" ? `Actions for ${original}` : name)).toEqual(before);
  await page.reload();
  await expect(page.getByRole("button", { name: "Actions for 로그인 오류 조사", exact: true })).toBeVisible();
  await assertViewportLocked(page);
});

test("detail editor preserves drafts on failure, blocks duplicate saves and handles Korean composition", async ({ page }) => {
  await page.goto("/#/task/t-idle-rich");
  await openRename(page, "Task actions");
  const input = page.getByRole("textbox", { name: "Session name" });
  await input.fill("세션 이름 수정");
  let requests = 0;
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    requests++;
    await pending;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Couldn't save. Try again." }) });
  });
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, keyCode: 229 });
  expect(requests).toBe(0);
  await expect(page.getByRole("dialog")).toBeVisible();
  await input.press("Enter");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("heading", { name: "세션 이름 수정", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Task actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Rename", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  expect(requests).toBe(1);
  release();
  await expect(page.getByText("Couldn't rename this session", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: original, exact: true })).toBeVisible();
  await openRename(page, "Task actions");
  await expect(input).toHaveValue("세션 이름 수정");
  await page.unroute(`**${path}`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("heading", { name: "세션 이름 수정", exact: true })).toBeVisible();
  await openRename(page, "Task actions");
  await input.fill("Discard this draft");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Task actions" })).toBeFocused();
  await expect(page.getByRole("heading", { name: "세션 이름 수정", exact: true })).toBeVisible();
});
