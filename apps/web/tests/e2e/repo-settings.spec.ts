import { test, expect, type Page } from "@playwright/test";
import type { RepoSettingsStatus } from "@palmagent/shared";
import { assertViewportLocked } from "./_helpers";

test.use({ serviceWorkers: "block" });

async function openSettings(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Spaces", exact: true }).click();
  const section = page.getByRole("region", { name: "Space search paths" });
  await section.getByRole("textbox").scrollIntoViewIfNeeded();
  return section;
}

test("search settings add and remove paths, disable discovery, and restore installation defaults", async ({ page }) => {
  let state: RepoSettingsStatus = { repoRoots: ["/projects"], defaults: ["/projects"], source: "installation", writable: true };
  const changes: unknown[] = [];
  await page.route("**/api/settings/repos", async (route) => {
    if (route.request().method() === "PATCH") {
      const change = route.request().postDataJSON(); changes.push(change);
      state = { ...state, source: change.action === "reset" ? "installation" : "saved",
        repoRoots: change.action === "add" ? [...state.repoRoots, ...change.paths]
          : change.action === "remove" ? state.repoRoots.filter((p) => !change.paths.includes(p)) : state.defaults };
    }
    await route.fulfill({ json: state });
  });
  const section = await openSettings(page);
  const longPath = "/mnt/engineering/product/experimental/mobile-repositories";
  await section.getByRole("textbox").fill(longPath);
  await section.getByRole("button", { name: "Add folder", exact: true }).click();
  await expect(section.getByRole("textbox")).toHaveValue("");
  await expect(section.getByText(longPath, { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 568 });
  await section.getByRole("button", { name: "Remove " + longPath, exact: true }).scrollIntoViewIfNeeded();
  expect(await page.locator('[data-slot="settings-scroll"]:visible').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await assertViewportLocked(page);
  await page.screenshot({ path: test.info().outputPath("repo-settings-mobile.png") });
  await section.getByRole("button", { name: "Remove /projects", exact: true }).click();
  await section.getByRole("button", { name: "Remove " + longPath, exact: true }).click();
  await expect(section.getByText(/Automatic search is off/)).toBeVisible();
  await section.getByRole("button", { name: "Use installation defaults" }).click();
  await expect(section.getByText("Using installation defaults.", { exact: true })).toBeVisible();
  await expect(section.getByText("/projects", { exact: true })).toBeVisible();
  expect(changes).toEqual([{ action: "add", paths: [longPath] }, { action: "remove", paths: ["/projects"] },
    { action: "remove", paths: [longPath] }, { action: "reset" }]);
  await page.reload();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Spaces", exact: true }).click();
  await section.getByRole("textbox").scrollIntoViewIfNeeded();
  await expect(section.getByText("/projects", { exact: true })).toBeVisible();
});

test("failed saves preserve input, reconcile server changes, and disable writes when offline", async ({ page }) => {
  let state: RepoSettingsStatus = { repoRoots: [], defaults: [], source: "saved", writable: true };
  let failReads = false;
  await page.route("**/api/settings/repos", async (route) => {
    if (route.request().method() === "PATCH") {
      const change = route.request().postDataJSON();
      if (change.paths[0] === "/missing") return route.fulfill({ status: 400, json: { error: "Search folder is missing or inaccessible: /missing" } });
      state = { ...state, repoRoots: change.paths };
      return route.fulfill({ status: 503, json: { error: "Response was lost. Refresh paths to confirm." } });
    }
    if (failReads) return route.abort("failed");
    return route.fulfill({ json: state });
  });
  const section = await openSettings(page);
  await section.getByRole("textbox").fill("/missing");
  await section.getByRole("button", { name: "Add folder" }).click();
  await expect(section.getByRole("alert")).toContainText("inaccessible");
  await expect(section.getByRole("textbox")).toHaveValue("/missing");
  await section.getByRole("textbox").fill("/saved");
  await section.getByRole("button", { name: "Add folder" }).click();
  await expect(section.getByText("/saved", { exact: true })).toBeVisible();
  await expect(section.getByRole("alert")).toContainText("Response was lost");
  failReads = true;
  await section.getByRole("button", { name: "Refresh paths" }).click();
  await expect(section.getByRole("textbox")).toHaveCount(0);
  await expect(section.getByRole("button", { name: "Refresh paths" })).toBeEnabled();
  failReads = false;
  await section.getByRole("button", { name: "Refresh paths" }).click();
  await expect(section.getByRole("textbox")).toBeEnabled();
});
