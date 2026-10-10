import { test } from "node:test";
import assert from "node:assert/strict";
import { baseRig, freshRun, freshProfile, restore, serialize, restoreCampaign, serializeCampaign, settleExpedition, launchExpedition,
  buyUpgrade, selectRobot, selectSector, selectStarter, robotUnlocked, masteryRank, maxHull, moveSpeed, pickupRadius,
  chooseUpgrade, chooseReward, dronePositions, missionComplete, relaysRestored, RELAY_SECONDS, ROBOT_KEYS, SECTOR_KEYS, SECTORS, step,
  type Campaign, type Robot, type Sector } from "../../src/games/scrap-survivor/engine";

const campaign = (robot: Robot = "scout", sector: Sector = 1): Campaign => ({
  run: freshRun(12, { ...baseRig(), robot, sector }), profile: freshProfile(), settled: false, hangar: false, report: null,
});
const finish = (c: Campaign) => {
  Object.assign(c.run, { won: true, boss: true, wardenDefeated: true, kills: 100, eliteWave: 2, elitesCleared: 2 });
  c.run.relays.forEach(relay => relay.charge = RELAY_SECONDS);
};

test("victory awards once across repeated callbacks and reload, and unlocks the next sector", () => {
  const c = campaign(); finish(c);
  assert.equal(settleExpedition(c), true);
  assert.equal(c.profile.parts, 67); assert.equal(c.profile.mastery.scout, 44);
  assert.equal(c.profile.unlockedSector, 2); assert.equal(c.profile.sector, 2);
  assert.equal(robotUnlocked(c.profile, "bulwark"), true); assert.equal(robotUnlocked(c.profile, "engineer"), false);
  const before = serializeCampaign(c);
  assert.equal(settleExpedition(c), false); assert.equal(serializeCampaign(c), before);
  const loaded = restoreCampaign(before);
  assert.deepEqual(loaded, { ...c, run: { ...c.run, effects: [] } });
  assert.equal(settleExpedition(loaded), false); assert.equal(serializeCampaign(loaded), before);
  assert.equal(launchExpedition(loaded), false);
  loaded.hangar = true; assert.equal(launchExpedition(loaded, 19), true);
  assert.equal(loaded.run.rig.sector, 2); assert.equal(loaded.profile.parts, 67); assert.equal(loaded.settled, false);
});

test("defeat and retreat retain half the earned salvage; opening or abandoning an empty run awards nothing", () => {
  const c = campaign(); assert.equal(settleExpedition(c), false); assert.equal(c.profile.parts, 0);
  c.run.kills = 50; c.run.eliteWave = 1; c.run.elitesCleared = 1;
  assert.equal(settleExpedition(c, true), true);
  assert.equal(c.profile.parts, 8); assert.equal(c.profile.mastery.scout, 9);
  assert.equal(c.profile.unlockedSector, 1); assert.equal(c.run.hull, 0); assert.equal(c.report?.outcome, "retreat");
  c.hangar = true; launchExpedition(c, 20); c.run.hull = 0; settleExpedition(c);
  assert.equal(c.profile.parts, 8); assert.equal(c.profile.mastery.scout, 9);
  assert.equal(c.report?.parts, 0); assert.equal(c.report?.outcome, "defeat");
});

test("purchases spend exact costs, stop at the cap, preserve unlock progress and apply only on next launch", () => {
  const c = campaign(); c.profile.parts = c.profile.earned = 200;
  const before = serialize(c.run);
  assert.equal(buyUpgrade(c.profile, "hull"), true); assert.equal(c.profile.parts, 180);
  assert.equal(buyUpgrade(c.profile, "hull"), true); assert.equal(buyUpgrade(c.profile, "hull"), true);
  assert.equal(buyUpgrade(c.profile, "hull"), false); assert.equal(c.profile.parts, 80); assert.equal(c.profile.earned, 200);
  assert.equal(serialize(c.run), before); assert.equal(robotUnlocked(c.profile, "engineer"), true);
  assert.equal(selectRobot(c.profile, "bulwark"), true); settleExpedition(c, true); c.hangar = true; launchExpedition(c, 5);
  assert.equal(c.run.hull, 14); assert.equal(maxHull(c.run), 14); assert.equal(c.run.upgrades.blade, 1); assert.equal(c.run.upgrades.bolt, 0);
  c.profile.workshop.hull = 0; assert.equal(maxHull(c.run), 14);
  const p = freshProfile(); assert.equal(buyUpgrade(p, "power"), false); assert.equal(p.parts, 0);
});

test("locked robots, sectors and alternate starters cannot be selected; mastery unlocks new choices and traits", () => {
  const c = campaign(), p = c.profile;
  assert.equal(selectRobot(p, "engineer"), false); assert.equal(selectSector(p, 2), false); assert.equal(selectStarter(p, "arc"), false);
  p.mastery.scout = 30; assert.equal(masteryRank(p.mastery.scout), 1); assert.equal(selectStarter(p, "arc"), true);
  settleExpedition(c, true); c.hangar = true; launchExpedition(c, 4);
  assert.equal(c.run.upgrades.arc, 1); assert.equal(c.run.upgrades.bolt, 0);
  assert.ok(moveSpeed(c.run) > moveSpeed(freshRun(1, { ...baseRig(), robot: "bulwark" })));
  const scout = freshRun(1, { ...baseRig(), mastery: 2 }); assert.equal(pickupRadius(scout) - pickupRadius(c.run), 25);
  const engineer = freshRun(1, { ...baseRig(), robot: "engineer", mastery: 2 }); assert.equal(dronePositions(engineer).length, 2);
  const heavy = freshRun(1, { ...baseRig(), robot: "bulwark", mastery: 2 }); heavy.hull = 3; heavy.choices = ["blade"];
  chooseUpgrade(heavy, "blade"); assert.equal(heavy.hull, 5);
  heavy.rewards = [{ kind: "repair" }]; chooseReward(heavy, 0); assert.equal(heavy.hull, 11);
});

test("sector relays require time in range, pause with choices, reward once, and gate victory", () => {
  const r = freshRun(7, { ...baseRig(), sector: 2 }); r.enemies = []; r.spawn = 10; r.hazardClock = 12;
  r.wardenDefeated = true; r.boss = true;
  step(r, { x: 0, y: 0 }); assert.equal(r.won, false); assert.equal(relaysRestored(r), 0);
  r.player = { x: r.relays[0].x, y: r.relays[0].y };
  for (let i = 0; i < 60; i++) step(r, { x: 0, y: 0 });
  assert.ok(r.relays[0].charge > 1.9 && r.relays[0].charge < 2.1);
  r.choices = ["bolt"]; const paused = serialize(r); step(r, { x: 1, y: 0 }); assert.equal(serialize(r), paused);
  r.choices = []; const loaded = restore(serialize(r));
  for (let i = 0; i < 95; i++) step(loaded, { x: 0, y: 0 });
  assert.equal(loaded.won, true); assert.equal(missionComplete(loaded), true); assert.equal(loaded.xp, 20);
  assert.equal(relaysRestored(loaded), 1); const done = serialize(loaded); step(loaded, { x: 0, y: 0 }); assert.equal(serialize(loaded), done);
});

test("hazards telegraph before damage, are avoidable, and resume deterministically", () => {
  const r = freshRun(1, { ...baseRig(), sector: 2 }); r.enemies = []; r.spawn = 10; r.hazardClock = 0; r.invulnerable = 0;
  step(r, { x: 0, y: 0 }); assert.equal(r.hazards.length, 1); assert.equal(r.hull, maxHull(r));
  const saved = serialize(r), escaped = restore(saved), still = restore(saved);
  for (let i = 0; i < 46; i++) { step(escaped, { x: 1, y: 0 }); step(still, { x: 0, y: 0 }); }
  assert.equal(escaped.hull, maxHull(escaped)); assert.ok(still.hull < maxHull(still));
  const resumed = restore(serialize(still)); still.effects = [];
  for (let i = 0; i < 60; i++) { step(still, { x: 0, y: 1 }); step(resumed, { x: 0, y: 1 }); }
  assert.deepEqual(resumed, still);
});

test("later sectors change encounters and volleys, not only health", () => {
  const runs = SECTOR_KEYS.map(sector => freshRun(3, { ...baseRig(), sector }));
  for (const r of runs) { r.enemies = []; r.spawn = 0; r.spawned = 8; r.time = 30; step(r, { x: 0, y: 0 }); }
  assert.equal(runs[0].enemies[0].kind, "charger"); assert.equal(runs[2].enemies[0].kind, "sentry");
  assert.ok(runs[2].spawn < runs[0].spawn);
  for (const r of runs) { r.time = 150; r.boss = false; r.bolt = 10; step(r, { x: 0, y: 0 }); }
  assert.ok(runs[2].enemies.find(e => e.kind === "boss")!.max > runs[0].enemies.find(e => e.kind === "boss")!.max);
  assert.equal(runs[0].hazards.length, 0); assert.equal(runs[2].relays.length, 3);
});

test("workshop damage and the engineer specialty affect actual hits, while salvage tuning uses launch-time levels", () => {
  const strike = (power: number) => {
    const r = freshRun(4, { ...baseRig(), workshop: { hull: 0, power, salvage: 0 } }, "arc");
    r.enemies = [{ id: ++r.id, kind: "drone", x: r.player.x + 100, y: r.player.y, hp: 100, max: 100, clock: 3, dash: 0, dx: 0, dy: 0 }];
    r.spawn = 10; step(r, { x: 0, y: 0 }); return 100 - r.enemies[0].hp;
  };
  assert.ok(Math.abs(strike(3) / strike(0) - 1.24) < 1e-10);
  const drones = ROBOT_KEYS.filter(robot => robot !== "bulwark").map(robot => {
    const r = freshRun(4, { ...baseRig(), robot }, "drone"); r.spawn = 10; step(r, { x: 0, y: 0 });
    return r.bullets.find(b => b.kind === "drone")!.damage;
  });
  assert.equal(drones[1] / drones[0], 1.25);
  const c = campaign(); c.profile.workshop.salvage = 3; finish(c); settleExpedition(c);
  assert.equal(c.report?.parts, 67);
  c.hangar = true; launchExpedition(c, 12); finish(c); settleExpedition(c);
  // The second launch uses sector two's bonus and the purchased salvage rig.
  assert.equal(c.report?.parts, Math.floor((20 + 12 + 20 + 50) * 1.3));
});

test("all robot and sector saves preserve rig stats, optional objectives and large boss health", () => {
  for (const robot of ROBOT_KEYS) for (const sector of SECTOR_KEYS) {
    const r = freshRun(15, { robot, sector, mastery: 2, workshop: { hull: 3, power: 3, salvage: 3 } });
    r.time = 150; step(r, { x: 0, y: 0 });
    assert.deepEqual(restore(serialize(r)), { ...r, effects: [] });
    assert.equal(r.relays.length, SECTORS[sector].relays);
  }
});

test("v3 saves migrate without interrupting the run; malformed new progression is rejected", () => {
  const old = freshRun(4); old.time = 90; old.upgrades.bolt = 3; old.choices = ["blade", "mine"];
  const data = { ...old, version: 3 }; const loaded = restoreCampaign(JSON.stringify(data));
  assert.equal(loaded.run.time, 90); assert.equal(loaded.run.upgrades.bolt, 3); assert.deepEqual(loaded.run.choices, old.choices);
  assert.equal(loaded.profile.parts, 0); assert.equal(loaded.run.rig.sector, 1);
  assert.deepEqual(loaded.run.relays, []);
  const c = campaign(); c.run.time = 45;
  for (const patch of [{ rig: { ...c.run.rig, sector: 4 } }, { rig: { ...c.run.rig, robot: "bad" } },
    { rig: { ...c.run.rig, workshop: { hull: 100, power: 0, salvage: 0 } } }, { hazards: [{ x: 0, y: 0, ttl: 99 }] },
    { relays: [{ x: 0, y: 0, charge: 99 }] }, { won: true }]) assert.equal(restore(JSON.stringify({ ...c.run, ...patch })).time, 0);
  const raw = JSON.parse(serializeCampaign(c)); raw.campaign.profile.parts = -20;
  assert.equal(restoreCampaign(JSON.stringify(raw)).profile.parts, 0);
});
