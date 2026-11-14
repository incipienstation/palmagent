import { expect, test } from "@playwright/test";

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
