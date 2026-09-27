import { expect, test } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";

async function openFolderBrowser(page: import("@playwright/test").Page) {
  await page.goto("/#/new/space/repo-app");
  await expect(page.getByRole("heading", { name: "New task" })).toBeVisible();
  await page.getByRole("combobox", { name: "Space" }).click();
  await page.getByRole("option", { name: "Add Space", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Add Space" })).toBeVisible();
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
    await expect(page.getByRole("option", { name: /Select this folder/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect Space" })).toHaveCount(0);

    await page.getByRole("option", { name: /nested-tools/ }).click();
    await expect(page.getByText("/projects/outer-repo/nested-tools", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("option", { name: /Select this folder/ })).toBeVisible();
    await assertViewportLocked(page);
  });

  test("Choose selects a repository directly with a phone-sized touch target", async ({ page }) => {
    const choose = page.getByRole("button", { name: "Choose outer-repo as Space" });
    const box = await choose.boundingBox();
    expect(box, "Choose action is laid out").not.toBeNull();
    expect(box!.height, "Choose action keeps a 44px mobile hit target").toBeGreaterThanOrEqual(44);

    await choose.click();
    await expect(page.getByText("✓ git repo · branch main")).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect Space" })).toBeVisible();
  });

});
