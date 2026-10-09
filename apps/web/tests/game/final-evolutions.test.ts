import { test } from "node:test";
import assert from "node:assert/strict";
import { freshRun, step, chooseUpgrade, chooseReward, openChest, canEvolve, restore, serialize, weaponCount,
  EVOLUTION_KEYS, EVOLUTIONS, type Enemy, type Run } from "../../src/games/scrap-survivor/engine";

function arena() {
  const r = freshRun(42); r.enemies = []; r.spawn = 10; r.bolt = 10;
  return r;
}
function enemy(r: Run, x: number, y: number, kind: Enemy["kind"] = "sentry") {
  const e: Enemy = { x: r.player.x + x, y: r.player.y + y, kind, hp: 500, max: 500, id: ++r.id, clock: 4, dash: 0, dx: 0, dy: 0 };
  r.enemies.push(e); return e;
}
function chest(r: Run) { const c = { ...r.player, id: ++r.id }; r.chests.push(c); return c.id; }

test("all five final forms require a chest selection, never a level or support upgrade", () => {
  assert.equal(EVOLUTION_KEYS.length, 5);
  for (const weapon of EVOLUTION_KEYS) {
    const r = arena(), passive = EVOLUTIONS[weapon].passive;
    r.upgrades.bolt = 0; r.upgrades[weapon] = 4; r.choices = [weapon];
    assert.equal(chooseUpgrade(r, weapon), true);
    assert.equal(canEvolve(r, weapon), false);
    r.choices = [passive]; assert.equal(chooseUpgrade(r, passive), true);
    assert.equal(canEvolve(r, weapon), true); assert.equal(r.evolutions[weapon], false);
    assert.equal(chooseReward(r, 0), false);
    r.xp = r.nextXp; step(r, { x: 0, y: 0 });
    assert.ok(r.choices.length > 0); assert.ok(!r.choices.includes(weapon));
    assert.ok(Object.values(r.evolutions).every(value => !value));
    chooseUpgrade(r, r.choices[0]);
    assert.equal(openChest(r, chest(r)), true);
    assert.deepEqual(r.rewards[0], { kind: "evolve", weapon });
    assert.equal(chooseReward(r, 0), true); assert.equal(chooseReward(r, 0), false);
    assert.equal(r.evolutions[weapon], true); assert.equal(r.upgrades[weapon], 5);
    assert.equal(weaponCount(r), 1); assert.equal(canEvolve(r, weapon), false);
  }
});

test("a chest prioritizes all eligible weapons and grants just one final form", () => {
  const r = arena(); r.upgrades.bolt = r.upgrades.mine = r.upgrades.drone = 5;
  r.upgrades.reactor = r.upgrades.magnet = 1;
  openChest(r, chest(r)); assert.deepEqual(r.rewards, ["bolt", "mine", "drone"].map(weapon => ({ kind: "evolve", weapon })));
  chooseReward(r, 1); assert.equal(r.evolutions.mine, true); assert.equal(r.evolutions.drone, false);
  assert.equal(chooseReward(r, 2), false);
  openChest(r, chest(r)); assert.deepEqual(r.rewards.slice(0, 2), ["bolt", "drone"].map(weapon => ({ kind: "evolve", weapon })));
  chooseReward(r, 1); assert.equal(Object.values(r.evolutions).filter(Boolean).length, 2);
  assert.equal(weaponCount(r), 3);
});

test("singularity mines pull before exploding, spare distant enemies and do not move bosses", () => {
  const r = arena(); r.upgrades.mine = 5; r.upgrades.magnet = 1; r.evolutions.mine = true; r.mine = 10;
  r.mines.push({ ...r.player, id: ++r.id, arm: 0, ttl: 9 });
  const trigger = enemy(r, 35, 0), pulled = enemy(r, 100, 0), boss = enemy(r, 100, 15, "boss"), far = enemy(r, 160, 0);
  const x = pulled.x, bx = boss.x, by = boss.y;
  step(r, { x: 0, y: 0 });
  assert.ok(pulled.x < x); assert.equal(boss.x, bx); assert.equal(boss.y, by);
  assert.equal(trigger.hp, 500); assert.ok(r.mines[0].fuse! > 0);
  for (let i = 0; i < 20; i++) step(r, { x: 0, y: 0 });
  assert.equal(r.mines.length, 0); assert.equal(trigger.hp, 468); assert.equal(pulled.hp, 468);
  assert.equal(boss.hp, 468); assert.equal(far.hp, 500);
  assert.ok(r.effects.some(fx => fx.kind === "implosion"));
  step(r, { x: 0, y: 0 }); assert.equal(trigger.hp, 468);
});

test("siege missiles replace drone bullets and damage each nearby enemy once per impact", () => {
  const r = arena(); r.upgrades.drone = 5; r.upgrades.reactor = 1; r.evolutions.drone = true;
  enemy(r, 170, 0); step(r, { x: 0, y: 0 });
  assert.equal(r.bullets.length, 3); assert.ok(r.bullets.every(b => b.kind === "missile"));
  const isolated = arena(); isolated.upgrades.drone = 5; isolated.upgrades.reactor = 1; isolated.evolutions.drone = true; isolated.drone = 10;
  const one = enemy(isolated, 100, 0), two = enemy(isolated, 110, 25), far = enemy(isolated, 175, 0);
  isolated.bullets.push({ ...one, id: ++isolated.id, vx: 0, vy: 0, ttl: 2, damage: 16.2, hostile: false, pierce: 0, hit: [], kind: "missile" });
  step(isolated, { x: 0, y: 0 });
  assert.equal(one.hp, 483.8); assert.equal(two.hp, 483.8); assert.equal(far.hp, 500);
  assert.equal(isolated.bullets.length, 0); assert.ok(isolated.effects.some(fx => fx.kind === "missile"));
  step(isolated, { x: 0, y: 0 }); assert.equal(two.hp, 483.8);
});

test("active gravity fuses and maximum-power siege missiles resume deterministically", () => {
  const a = arena(); a.rig.robot = "engineer"; a.hull = 7; a.rig.mastery = 2; a.rig.workshop.power = 3;
  a.upgrades.mine = a.upgrades.drone = 5; a.upgrades.reactor = 3; a.upgrades.magnet = 1;
  a.evolutions.mine = a.evolutions.drone = true;
  enemy(a, 35, 0); enemy(a, 130, 0);
  for (let i = 0; i < 11; i++) step(a, { x: 0, y: 0 });
  assert.ok(a.mines.some(m => m.fuse !== undefined)); assert.ok(a.bullets.some(b => b.kind === "missile"));
  const b = restore(serialize(a)); assert.equal(b.time, a.time); a.effects = [];
  for (let i = 0; i < 30; i++) { step(a, { x: 0.5, y: 1 }); step(b, { x: 0.5, y: 1 }); }
  assert.deepEqual(a, b);
});

test("version four preserves existing final forms and pending chests without granting new ones", () => {
  const r = arena(); r.time = 80; r.upgrades.bolt = r.upgrades.mine = 5; r.upgrades.reactor = r.upgrades.magnet = 1;
  r.evolutions.bolt = true; openChest(r, chest(r));
  const raw = JSON.parse(serialize(r)); raw.version = 4; delete raw.evolutions.mine; delete raw.evolutions.drone;
  // Version four offered only supplies for a mine build; migrating must retain that exact offer.
  raw.rewards = [{ kind: "upgrade", upgrade: "reactor" }, { kind: "repair" }];
  const restored = restore(JSON.stringify(raw)); assert.equal(restored.version, 5); assert.equal(restored.time, 80);
  assert.equal(restored.evolutions.bolt, true); assert.equal(restored.evolutions.mine, false); assert.equal(restored.evolutions.drone, false);
  assert.deepEqual(restored.rewards, raw.rewards);
});

test("invalid final-form saves reject malformed fuses, missiles, and missing prerequisites", () => {
  const r = arena(); r.time = 42; r.upgrades.mine = r.upgrades.drone = 5; r.upgrades.reactor = r.upgrades.magnet = 1;
  r.evolutions.mine = r.evolutions.drone = true; r.id++;
  const mine = { ...r.player, id: r.id, ttl: 8, arm: 0, fuse: 0.5 };
  const missile = { ...r.player, id: r.id, vx: 240, vy: 0, ttl: 1, damage: 12, hostile: false, pierce: 0, hit: [], kind: "missile" };
  const invalid = [{ mines: [{ ...mine, fuse: 0.7 }] }, { mines: [{ ...mine, fuse: -1 }] },
    { mines: [mine], evolutions: { ...r.evolutions, mine: false } }, { bullets: [{ ...missile, hostile: true }] },
    { bullets: [missile], evolutions: { ...r.evolutions, drone: false } }, { bullets: [{ ...missile, damage: 41 }] },
    { upgrades: { ...r.upgrades, magnet: 0 } }, { evolutions: { ...r.evolutions, mine: "true" } }];
  for (const patch of invalid) assert.equal(restore(JSON.stringify({ ...r, ...patch })).time, 0);
});
