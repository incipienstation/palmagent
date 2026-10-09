import { expect, test, type Page } from "@playwright/test";
import { baseRig, freshRun, freshProfile, serializeCampaign, SAVE_KEY, LEGACY_SAVE_KEY, RELAY_SECONDS, type Campaign } from "../../src/games/scrap-survivor/engine";
import { assertViewportLocked } from "./_helpers";
import { installScopedStream, open as openSession, send } from "./_session-stream";

test.use({ serviceWorkers: "block" });
const game = (page: Page) => page.getByRole("dialog", { name: "Scrap Survivor", exact: true });
const hangar = (page: Page) => game(page).getByRole("region", { name: "Hangar", exact: true });
const saved = (page: Page) => page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY);
const open = (page: Page) => page.getByRole("button", { name: "Open arcade", exact: true }).click();
const campaign = (): Campaign => ({ run: freshRun(8), profile: freshProfile(), settled: false, hangar: false, report: null });
async function seed(page: Page, c: Campaign) {
  await page.addInitScript(({ key, value }) => {
    localStorage.setItem("pref:adhd-mode", "on");
    if (!localStorage.getItem(key)) localStorage.setItem(key, value);
  }, { key: SAVE_KEY, value: serializeCampaign(c) });
}

test("victory survives reload once; the hangar spends parts, selects an unlocked robot, and launches the next sector", async ({ page }) => {
  const c = campaign(); Object.assign(c.run, { won: true, boss: true, wardenDefeated: true, kills: 100, eliteWave: 2, elitesCleared: 2 });
  c.run.relays[0].charge = RELAY_SECONDS;
  await seed(page, c); await page.goto("/#/task/t-run"); await open(page);
  await expect(game(page).getByRole("region", { name: "Expedition rewards" })).toContainText("+67 parts");
  await expect.poll(async () => (await saved(page)).campaign.profile.parts).toBe(67);
  await game(page).getByRole("button", { name: "New expedition" }).click();
  await expect(hangar(page)).toBeVisible();
  await expect(hangar(page).getByRole("radio", { name: "Engineer", exact: true })).toBeDisabled();
  await hangar(page).getByRole("radio", { name: "Bulwark", exact: true }).click();
  await hangar(page).getByRole("button", { name: "Upgrade Hull plating" }).click();
  await expect.poll(async () => (await saved(page)).campaign.profile.parts).toBe(47);
  await game(page).getByRole("button", { name: "Back to chat" }).click(); await page.reload(); await open(page);
  await expect(hangar(page)).toBeVisible();
  await expect(hangar(page).getByText("47 parts", { exact: true })).toBeVisible();
  await expect(hangar(page).getByRole("radio", { name: "Bulwark", exact: true })).toHaveAttribute("aria-checked", "true");
  await hangar(page).getByRole("button", { name: "Launch expedition" }).click();
  await expect(hangar(page)).toHaveCount(0);
  await expect(game(page).getByRole("meter", { name: "Player HP" })).toHaveAttribute("aria-valuemax", "12");
  await expect(game(page).getByRole("img", { name: "Orbiting blades level 1", exact: true })).toBeVisible();
  await expect.poll(async () => (await saved(page)).rig.sector).toBe(2);
  const run = await saved(page); expect(run.upgrades.bolt).toBe(0); expect(run.campaign.profile.parts).toBe(47);
  await game(page).getByRole("button", { name: "Pause game" }).click();
  await page.reload(); await open(page);
  await expect(game(page).getByRole("meter", { name: "Player HP" })).toHaveAttribute("aria-valuemax", "12");
  expect((await saved(page)).rig.robot).toBe("bulwark");
});

test("hangar pauses a live run, preserves drafts and purchases through final reply, and applies them after retreat", async ({ page }) => {
  const c = campaign(); c.profile.parts = c.profile.earned = 100; c.profile.mastery.engineer = 90;
  c.run.enemies = []; c.run.spawn = 10;
  await seed(page, c); await installScopedStream(page); await openSession(page, "t-run");
  const draft = page.getByRole("textbox", { name: "Message", exact: true }); await draft.fill("Keep this while upgrading");
  await open(page); await game(page).getByRole("button", { name: "Open hangar" }).click();
  await expect(hangar(page)).toBeVisible();
  const checkpoint = await saved(page);
  await hangar(page).getByRole("button", { name: "Upgrade Hull plating" }).click();
  await hangar(page).getByRole("radio", { name: "Engineer", exact: true }).click();
  await hangar(page).getByRole("radio", { name: "Scrap mines", exact: true }).click();
  expect((await saved(page)).rig.workshop.hull).toBe(0);
  expect((await saved(page)).time).toBe(checkpoint.time);
  await send(page, "t-run", { type: "event", event: { taskId: "t-run", agent: "codex", ts: 1, kind: "assistant_text", payload: { text: "Ready for your review", messageId: "campaign-final", phase: "final" } } }, 1);
  await expect(game(page)).toHaveCount(0); await expect(draft).toHaveValue("Keep this while upgrading");
  await open(page); await expect(hangar(page)).toBeVisible();
  await hangar(page).getByRole("button", { name: "End current expedition" }).click();
  await game(page).getByRole("button", { name: "Keep this run" }).click();
  expect((await saved(page)).hull).toBe(8);
  await hangar(page).getByRole("button", { name: "End current expedition" }).click();
  await game(page).getByRole("button", { name: "Return to hangar", exact: true }).click();
  await expect(hangar(page).getByRole("region", { name: "Expedition rewards" })).toContainText("+0 parts");
  await hangar(page).getByRole("button", { name: "Launch expedition" }).click();
  const launched = await saved(page); expect(launched.rig.robot).toBe("engineer"); expect(launched.rig.mastery).toBe(2);
  expect(launched.upgrades.mine).toBe(1); expect(launched.upgrades.bolt).toBe(0); expect(launched.campaign.profile.parts).toBe(80);
  await expect(game(page).getByRole("meter", { name: "Player HP" })).toHaveAttribute("aria-valuemax", "8");
});

test("a required relay finishes the expedition after the Warden; short-screen hangar controls remain reachable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 480 });
  const c = campaign(); c.profile.unlockedSector = 2; c.run = freshRun(8, { ...baseRig(), sector: 2 });
  c.run.wardenDefeated = true; c.run.boss = true; c.run.enemies = []; c.run.spawn = 10;
  const relay = c.run.relays[0]; relay.charge = 4.5; c.run.player = { x: relay.x, y: relay.y };
  await seed(page, c); await page.goto("/#/task/t-run"); await open(page);
  await expect(game(page).getByRole("button", { name: "Movement joystick" })).toBeEnabled();
  await expect(game(page).getByText("Warden defeated!", { exact: true })).toBeVisible();
  await expect.poll(async () => (await saved(page)).campaign.profile.unlockedSector).toBe(3);
  await game(page).getByRole("button", { name: "New expedition" }).click();
  await expect(hangar(page).getByRole("radio", { name: "Sector 3: Stormworks", exact: true })).toBeEnabled();
  await hangar(page).getByRole("button", { name: "Upgrade Weapon tuning" }).click();
  await hangar(page).getByRole("radio", { name: "Sector 1: Scrapyard", exact: true }).click();
  await hangar(page).getByRole("button", { name: "Launch expedition" }).click();
  await expect(game(page).getByRole("button", { name: "Movement joystick" })).toBeEnabled();
  expect((await saved(page)).rig.sector).toBe(1);
  await assertViewportLocked(page);
});

test("a failed storage write retains settlement and purchases through closing and reopening the game", async ({ page }) => {
  const c = campaign(); c.run.hull = 0; c.run.kills = 250;
  await seed(page, c);
  await page.addInitScript(key => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function(k, v) { if (k === key && this.getItem(k)) throw new Error("Storage unavailable"); set.call(this, k, v); };
  }, SAVE_KEY);
  await page.goto("/#/task/t-run"); await open(page);
  await expect(game(page).getByRole("region", { name: "Expedition rewards" })).toContainText("+25 parts");
  await game(page).getByRole("button", { name: "New expedition" }).click();
  await hangar(page).getByRole("button", { name: "Upgrade Hull plating" }).click();
  await expect(hangar(page).getByText("5 parts", { exact: true })).toBeVisible();
  await expect(game(page).getByText("Progress could not be saved. Keep this tab open.")).toBeVisible();
  await game(page).getByRole("button", { name: "Back to chat" }).click(); await open(page);
  await expect(hangar(page).getByText("5 parts", { exact: true })).toBeVisible();
  await expect(hangar(page).getByText("Hull plating · 1/3", { exact: true })).toBeVisible();
  await hangar(page).getByRole("button", { name: "Launch expedition" }).click();
  await expect(game(page).getByRole("meter", { name: "Player HP" })).toHaveAttribute("aria-valuemax", "9");
});

test("legacy storage migrates once; an older client cannot replace the campaign snapshot", async ({ page }) => {
  const run = freshRun(8); run.time = 73; run.upgrades.blade = 2; run.choices = ["bolt", "arc", "boots"];
  await page.addInitScript(({ key, value }) => {
    localStorage.setItem("pref:adhd-mode", "on");
    if (!localStorage.getItem(key)) localStorage.setItem(key, value);
  }, { key: LEGACY_SAVE_KEY, value: JSON.stringify({ ...run, version: 3 }) });
  await page.goto("/#/task/t-run"); await open(page);
  await expect(game(page).getByRole("region", { name: "Choose an upgrade" })).toBeVisible();
  await expect.poll(async () => (await saved(page))?.upgrades.blade).toBe(2);
  expect((await saved(page)).time).toBe(73);
  await game(page).getByRole("button", { name: "Back to chat" }).click();
  await page.evaluate(key => localStorage.setItem(key, "null"), LEGACY_SAVE_KEY);
  await page.reload(); await open(page);
  await expect(game(page).getByRole("region", { name: "Choose an upgrade" })).toBeVisible();
  expect((await saved(page)).upgrades.blade).toBe(2); expect((await saved(page)).time).toBe(73);
});
