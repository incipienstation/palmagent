import { test, expect } from "@playwright/test";
import { repos } from "../fixtures.mjs";
import { assertViewportLocked } from "./_helpers";

test.use({ serviceWorkers: "block" });
for (const viewport of [{ width: 360, height: 780 }, { width: 1280, height: 900 }]) {
  test(`base branch settings validate, save, and survive reload at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const state = structuredClone(repos);
    const writes: unknown[] = [];
    await page.route("**/api/repos", route => route.fulfill({ json: { repos: state } }));
    await page.route("**/api/repos/repo-app", async route => {
      const body = route.request().postDataJSON(); writes.push(body);
      if (body.defaultBaseRef === "missing") return route.fulfill({ status: 400, json: { error: "Base branch must resolve to an existing local Git commit." } });
      state[0].defaultBaseRef = body.defaultBaseRef;
      return route.fulfill({ json: { repo: state[0] } });
    });
    const open = async () => {
      if (viewport.width < 768) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Space settings", exact: true }).click();
    };
    await page.goto("/"); await open();
    const form = page.getByRole("form", { name: "Base branch for sample-app" });
    const input = form.getByLabel("Base branch", { exact: true });
    const save = form.getByRole("button", { name: "Save base branch" });
    await expect(input).toHaveValue("main");
    await expect(save).toBeDisabled();
    await expect(page.getByRole("form", { name: "Base branch for notes" })).toHaveCount(0);
    await input.fill("missing"); await save.click();
    await expect(form.getByRole("alert")).toContainText("existing local Git commit");
    await expect(input).toHaveValue("missing");
    await input.fill("develop"); await save.click();
    await expect(form.getByRole("status")).toContainText("Saved");
    await expect(save).toBeDisabled();
    expect(writes).toEqual([{ defaultBaseRef: "missing" }, { defaultBaseRef: "develop" }]);
    await assertViewportLocked(page);
    await page.screenshot({ path: test.info().outputPath(`space-settings-${viewport.width}.png`) });
    await page.reload(); await open();
    await expect(input).toHaveValue("develop");
    await page.getByRole("button", { name: "Back to settings", exact: true }).click();
    await expect(page.getByRole("button", { name: "Space settings", exact: true })).toBeFocused();
  });
}

for (const baseRef of ["", "develop"]) {
  test(`registration ${baseRef ? "sends an explicit base branch" : "leaves the base branch to automatic detection"}`, async ({ page }) => {
    let registered: Record<string, unknown> | undefined;
    await page.route("**/api/repos", async route => {
      if (route.request().method() !== "POST") return route.fulfill({ json: { repos } });
      registered = route.request().postDataJSON();
      await route.fulfill({ status: 201, json: { repo: { id: "repo-new", name: "outer-repo", path: "/projects/outer-repo", vcs: "git", defaultBaseRef: "develop", createdAt: 1 } } });
    });
    await page.goto("/#/new/space/repo-app");
    await page.getByRole("combobox", { name: "Space" }).click();
    await page.getByRole("option", { name: "Add Space", exact: true }).click();
    await page.getByRole("option", { name: "Browse folders…" }).click();
    await page.getByRole("button", { name: "Choose outer-repo as Space" }).click();
    const input = page.getByLabel("Base branch (optional)");
    await expect(input).toHaveValue("");
    if (baseRef) await input.fill(baseRef);
    await page.getByRole("button", { name: "Connect Space", exact: true }).click();
    await expect.poll(() => registered).toEqual({ path: "/projects/outer-repo", ...(baseRef ? { defaultBaseRef: baseRef } : {}) });
    await expect(page.getByRole("heading", { name: "Add Space" })).toHaveCount(0);
    await assertViewportLocked(page);
  });
}
