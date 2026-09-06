import { expect, test } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";

async function openFolderBrowser(page: import("@playwright/test").Page) {
  await page.goto("/#/new");
  await expect(page.getByRole("heading", { name: "Dispatch" })).toBeVisible();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Add a repo" })).toBeVisible();
  await page.getByRole("option", { name: "Browse folders…" }).click();
  await expect(page.getByText("/projects", { exact: true })).toBeVisible();
}

test.describe("nested repository picker", () => {
  test.beforeEach(async ({ page }) => {
    await openFolderBrowser(page);
  });

  test("repository rows browse inward without selecting, including nested repositories", async ({ page }) => {
    await page.getByRole("option", { name: /outer-repo/ }).click();
    await expect(page.getByText("/projects/outer-repo", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("option", { name: /Select this repo/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Register" })).toHaveCount(0);

    await page.getByRole("option", { name: /nested-tools/ }).click();
    await expect(page.getByText("/projects/outer-repo/nested-tools", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("option", { name: /Select this repo/ })).toBeVisible();
    await assertViewportLocked(page);
  });

  test("Choose selects a repository directly with a phone-sized touch target", async ({ page }) => {
    const choose = page.getByRole("button", { name: "Choose outer-repo as repository" });
    const box = await choose.boundingBox();
    expect(box, "Choose action is laid out").not.toBeNull();
    expect(box!.height, "Choose action keeps a 44px mobile hit target").toBeGreaterThanOrEqual(44);

    await choose.click();
    await expect(page.getByText("✓ git repo · branch main")).toBeVisible();
    await expect(page.getByRole("button", { name: "Register" })).toBeVisible();
  });

  test("matches the nested-browse visual baseline", async ({ page }) => {
    await page.getByRole("option", { name: /outer-repo/ }).click();
    await expect(page.getByText("/projects/outer-repo", { exact: true }).first()).toBeVisible();
    await expect(page).toHaveScreenshot("repo-picker-nested.png");
  });
});
