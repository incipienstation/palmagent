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

for (const staleFailure of [false, true]) test(`reopening discovery discards the old ${staleFailure ? "failure" : "response"}`, async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  let oldFinished = false;
  const result = (name: string) => ({ roots: ["/projects"], scannedAt: 1,
    repos: [{ name, path: `/projects/${name}`, branch: "main", lastActivityAt: 1 }] });
  await page.route("**/api/repos/discover*", async route => {
    if (++requests === 1) {
      await gate;
      try { await route.fulfill(staleFailure ? { status: 500, json: { error: "Old discovery failed" } }
        : { json: result("old-scan") }); }
      finally { oldFinished = true; }
    } else await route.fulfill({ json: result("new-scan") });
  });
  const open = async () => {
    await page.getByRole("combobox", { name: "Space" }).click();
    await page.getByRole("option", { name: "Add Space", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Add Space" })).toBeVisible();
  };
  await page.goto("/#/new/space/repo-app");
  await open(); await expect.poll(() => requests).toBe(1);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Add Space" })).toBeHidden();
  await open();
  await expect(page.getByRole("option", { name: /new-scan/ })).toBeVisible();
  release(); await expect.poll(() => oldFinished).toBe(true);
  await expect(page.getByRole("option", { name: /new-scan/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /old-scan/ })).toHaveCount(0);
  await expect(page.getByText("Old discovery failed")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Rescan folders" })).toBeEnabled();
});
