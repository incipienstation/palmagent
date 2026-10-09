import { test } from "node:test";
import assert from "node:assert/strict";
import { freshRun, step, chooseUpgrade, chooseReward, openChest, canEvolve, restore, serialize, weaponCount,
  ELITE_TIMES, type Enemy, type Run, type Upgrade } from "../../src/games/scrap-survivor/engine";

function arena() {
  const r = freshRun(42); r.enemies = []; r.spawn = 10; r.bolt = 10;
  return r;
}
function enemy(r: Run, x: number, y: number, kind: Enemy["kind"] = "drone", hp = 100) {
  const e: Enemy = { x: r.player.x + x, y: r.player.y + y, kind, hp, max: hp, id: ++r.id, clock: 4, dash: 0, dx: 0, dy: 0 };
  r.enemies.push(e); return e;
}
function chest(r: Run) { const c = { ...r.player, id: ++r.id }; r.chests.push(c); return c.id; }

test("three weapon slots constrain offers and claims, while supports remain available", () => {
  const r = arena(); r.upgrades.mine = 1; r.upgrades.drone = 1;
  r.choices = ["blade"]; assert.equal(chooseUpgrade(r, "blade"), false);
  r.choices = []; r.xp = r.nextXp; step(r, { x: 0, y: 0 });
  assert.ok(r.choices.every(k => k !== "blade" && k !== "arc"));
  assert.equal(weaponCount(r), 3);
  r.choices = ["reactor"]; assert.equal(chooseUpgrade(r, "reactor"), true);
  assert.equal(weaponCount(r), 3);
});

test("mines arm before detonating, damage a group, and expire once", () => {
  const r = arena(); r.upgrades.mine = 1;
  const a = enemy(r, 25, 0), b = enemy(r, 50, 0), far = enemy(r, 150, 0);
  step(r, { x: 0, y: 0 }); assert.equal(a.hp, 100); assert.equal(r.mines.length, 1);
  for (let i = 0; i < 10; i++) step(r, { x: 0, y: 0 });
  assert.equal(a.hp, 90); assert.equal(b.hp, 90); assert.equal(far.hp, 100); assert.equal(r.mines.length, 0);
  step(r, { x: 0, y: 0 }); assert.equal(a.hp, 90);
});

test("support drones gain distinct projectiles at levels three and five", () => {
  for (const [level, count] of [[1, 1], [3, 2], [5, 3]]) {
    const r = arena(); r.upgrades.drone = level; enemy(r, 120, 0);
    step(r, { x: 0, y: 0 }); assert.equal(r.bullets.filter(b => b.kind === "drone").length, count);
    for (let i = 0; i < 20; i++) step(r, { x: 0, y: 0 });
    assert.ok(r.enemies[0].hp < 100);
  }
});

test("elite thresholds spawn once, kills drop chests, and rewards pause and survive reload", () => {
  const r = arena(); r.upgrades.bolt = 5; r.upgrades.reactor = 1;
  for (const [index, time] of ELITE_TIMES.entries()) {
    r.time = time; step(r, { x: 0, y: 0 });
    assert.equal(r.eliteWave, index + 1);
    const elite = r.enemies.find(e => e.kind === "elite")!;
    assert.ok(elite); step(r, { x: 0, y: 0 }); assert.equal(r.enemies.filter(e => e.kind === "elite").length, 1);
    elite.x = r.player.x + 60; elite.y = r.player.y; elite.hp = 1;
    r.upgrades.blade = 5; r.blade = 0; step(r, { x: 0, y: 0 });
    assert.equal(r.elitesCleared, index + 1); assert.equal(r.chests.length, 1);
    const c = r.chests[0]; assert.equal(openChest(r, c.id), false);
    r.player = { x: c.x, y: c.y }; assert.equal(openChest(r, c.id), true);
    assert.equal(openChest(r, c.id), false);
    const before = serialize(r); step(r, { x: 1, y: 1 }); assert.equal(serialize(r), before);
    assert.deepEqual(restore(before), { ...r, effects: [] });
    assert.equal(chooseReward(r, 0), true); assert.equal(chooseReward(r, 0), false);
  }
  assert.equal(r.evolutions.bolt, true);
});

test("evolutions require both components and an unclaimed chest", () => {
  const r = arena(); r.upgrades.bolt = 5;
  assert.equal(canEvolve(r, "bolt"), false); r.upgrades.reactor = 1; assert.equal(canEvolve(r, "bolt"), true);
  assert.equal(chooseReward(r, 0), false);
  assert.equal(openChest(r, chest(r)), true);
  assert.deepEqual(r.rewards[0], { kind: "evolve", weapon: "bolt" });
  const loaded = restore(serialize(r)); assert.equal(chooseReward(loaded, 0), true);
  assert.equal(canEvolve(loaded, "bolt"), false); assert.equal(loaded.evolutions.bolt, true);
  assert.equal(loaded.upgrades.bolt, 5); assert.equal(weaponCount(loaded), 1);
});

test("railgun pierces a line, grinder extends its reach, and storm shocks adjacent enemies", () => {
  const rail = arena(); rail.upgrades.bolt = 5; rail.upgrades.reactor = 1; rail.evolutions.bolt = true; rail.bolt = 0;
  const near = enemy(rail, 100, 0), behind = enemy(rail, 300, 0), outside = enemy(rail, 100, 100);
  step(rail, { x: 0, y: 0 }); assert.ok(near.hp < 50); assert.equal(near.hp, behind.hp); assert.equal(outside.hp, 100);
  const grinder = arena(); grinder.upgrades.blade = 5; grinder.upgrades.magnet = 1; grinder.evolutions.blade = true;
  const edge = enemy(grinder, 110, 0); step(grinder, { x: 0, y: 0 }); assert.ok(edge.hp < 100);
  const storm = arena(); storm.upgrades.arc = 5; storm.upgrades.boots = 1; storm.evolutions.arc = true;
  const one = enemy(storm, 100, 0), two = enemy(storm, 110, 0);
  step(storm, { x: 0, y: 0 }); assert.equal(one.hp, 89); assert.equal(two.hp, 89);
});

test("active new weapons resume deterministically and invalid new save fields are rejected", () => {
  const a = arena(); a.upgrades.mine = 5; a.upgrades.drone = 5; enemy(a, 120, 0);
  for (let i = 0; i < 12; i++) step(a, { x: 0, y: 0 });
  const b = restore(serialize(a)); a.effects = [];
  for (let i = 0; i < 40; i++) { step(a, { x: 0.5, y: 1 }); step(b, { x: 0.5, y: 1 }); }
  assert.deepEqual(b, a);
  const invalid = [ { mines: [{ id: 1, x: 0, y: 0, ttl: 50, arm: 0 }] }, { eliteWave: 3 },
    { evolutions: { bolt: true, blade: false, arc: false } }, { rewards: [{ kind: "evolve", weapon: "mine" }] },
    { rewards: [{ kind: "upgrade", upgrade: "blade" }] }, { upgrades: { ...a.upgrades, blade: 1 } },
    { chests: [{ ...a.player, id: 1 }, { ...a.player, id: 1 }] } ];
  for (const patch of invalid) assert.equal(restore(JSON.stringify({ ...a, ...patch })).time, 0);
});

test("version two retains equipment and pending choices without retroactive elites", () => {
  const r = arena(); r.time = 120; r.upgrades.blade = 3; r.upgrades.arc = 2; r.choices = ["bolt", "blade", "magnet"];
  const raw = JSON.parse(serialize(r)); raw.version = 2; delete raw.upgrades.mine; delete raw.upgrades.drone;
  const loaded = restore(JSON.stringify(raw)); assert.equal(loaded.time, 120); assert.equal(loaded.eliteWave, 2);
  assert.equal(loaded.upgrades.blade, 3); assert.deepEqual(loaded.choices, r.choices);
  chooseUpgrade(loaded, "bolt"); step(loaded, { x: 0, y: 0 }); assert.ok(!loaded.enemies.some(e => e.kind === "elite"));
});
