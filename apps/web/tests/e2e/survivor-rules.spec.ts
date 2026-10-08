import { expect, test } from "@playwright/test";
import { chooseUpgrade, freshRun, restore, serialize, step, WORLD_W, WORLD_H, W, H, type Run, type Upgrade } from "../../src/games/scrap-survivor/engine";

function steer(r: Run) {
  const gem = [...r.gems].sort((a, b) => Math.hypot(a.x - r.player.x, a.y - r.player.y) - Math.hypot(b.x - r.player.x, b.y - r.player.y))[0];
  let x = Math.cos(r.time / 5), y = Math.sin(r.time / 5);
  if (gem) { const d = Math.hypot(gem.x - r.player.x, gem.y - r.player.y) || 1; x = (gem.x - r.player.x) / d; y = (gem.y - r.player.y) / d; }
  for (const e of r.enemies) { const dx = r.player.x - e.x, dy = r.player.y - e.y, d = Math.hypot(dx, dy) || 1;
    if (d < 85) { x += dx / d * (85 - d) / 20; y += dy / d * (85 - d) / 20; } }
  if (r.player.x < 55) x += 2; if (r.player.x > WORLD_W - 55) x -= 2; if (r.player.y < 55) y += 2; if (r.player.y > WORLD_H - 55) y -= 2;
  return { x, y };
}
test("movement, automatic attacks, scrap collection and choices produce a winnable run", () => {
  let victories = 0;
  for (const seed of [1, 2]) {
    const r = freshRun(seed); let first = 0; const types = new Set<string>();
    for (let frame = 0; frame < 30 * 240 && r.hull > 0 && !r.won; frame++) {
      r.enemies.forEach(e => types.add(e.kind));
      if (r.choices.length) {
        if (!first) first = r.time;
        const before = serialize(r); step(r, { x: 1, y: 0 }); expect(serialize(r)).toBe(before);
        const preferred = ["blade", "bolt", "arc", "reactor", "magnet", "boots"] as Upgrade[];
        expect(chooseUpgrade(r, preferred.find(k => r.choices.includes(k))!)).toBe(true);
      }
      step(r, steer(r));
    }
    expect(first).toBeLessThan(15);
    expect(r.kills).toBeGreaterThan(100);
    expect(types).toEqual(new Set(["drone", "charger", "sentry", "boss"]));
    expect(r.won || r.hull === 0, `seed ${seed} reaches a terminal state`).toBe(true);
    if (r.won) victories++;
    expect(restore(serialize(r))).toEqual({ ...r, effects: [] });
    const saved = serialize(r); step(r, { x: 1, y: 1 }); expect(serialize(r)).toBe(saved);
  }
  // Larger-world approaches differ by seed; this fixed steering policy must still reach victory.
  expect(victories).toBeGreaterThan(0);
});
test("saved runs resume deterministically; malformed saves cannot poison the simulation", () => {
  const a = freshRun(42); for (let i = 0; i < 100; i++) step(a, { x: 0.5, y: 1 });
  const b = restore(serialize(a)); a.effects = [];
  for (let i = 0; i < 100; i++) { step(a, { x: -1, y: 0 }); step(b, { x: -1, y: 0 }); }
  expect(b).toEqual(a);
  for (const data of [null, "null", "bad", JSON.stringify({ ...a, player: { x: "bad", y: 0 } }), JSON.stringify({ ...a, upgrades: {} }), JSON.stringify({ ...a, enemies: [{}] }), JSON.stringify({ ...a, choices: ["unknown"] })]) expect(restore(data).time).toBe(0);
  expect(chooseUpgrade(a, "arc")).toBe(false);
  a.hull = 0; const dead = serialize(a); step(a, { x: 1, y: 1 }); expect(serialize(a)).toBe(dead);
});
test("weapon upgrades change the attacks and diagonal movement cannot move faster", () => {
  const a = freshRun(3), b = freshRun(3); step(a, { x: 1, y: 0 }); step(b, { x: 1, y: 1 });
  expect(Math.hypot(a.player.x - WORLD_W / 2, a.player.y - WORLD_H / 2)).toBeCloseTo(Math.hypot(b.player.x - WORLD_W / 2, b.player.y - WORLD_H / 2));
  const r = freshRun(1); r.upgrades.bolt = 5; r.upgrades.arc = 2; r.upgrades.blade = 2;
  step(r, { x: 0, y: 0 });
  expect(r.bullets.filter(b => !b.hostile)).toHaveLength(5);
  expect(r.bullets[0].pierce).toBe(3);
  expect(r.effects.some(f => f.kind === "arc")).toBe(true);
  r.enemies[0].hp = 2; r.enemies[0].x = r.player.x + 30; r.enemies[0].y = r.player.y; r.blade = 0;
  const kills = r.kills; step(r, { x: 0, y: 0 }); expect(r.kills).toBeGreaterThan(kills);
});

test("legacy saves move into the expanded map without losing relative positions or progress", () => {
  const r = freshRun(42); r.version = 1; r.player = { x: W / 2, y: H / 2 }; r.enemies = [];
  r.id = 2; r.gems = [{ id: 1, x: 200, y: 300, value: 4 }];
  r.bullets = [{ id: 2, x: 220, y: 310, vx: 10, vy: 0, ttl: 1, damage: 2, hostile: false, pierce: 0, hit: [] }];
  r.time = 71; r.hull = 5;
  const restored = restore(serialize(r));
  expect(restored.version).toBe(2); expect(restored.time).toBe(71); expect(restored.hull).toBe(5);
  expect(restored.player).toEqual({ x: WORLD_W / 2, y: WORLD_H / 2 });
  expect(restored.gems[0].x - restored.player.x).toBe(-40);
  expect(restored.bullets[0].y - restored.player.y).toBe(-10);
  expect(restore(serialize(restored))).toEqual(restored);
});
test("expanded-world movement and edge spawns remain bounded without spawning on the player", () => {
  for (const player of [{ x: 22, y: 22 }, { x: WORLD_W - 22, y: WORLD_H - 22 }, { x: WORLD_W / 2, y: WORLD_H / 2 }]) {
    const r = freshRun(7); r.player = player; r.enemies = []; r.spawn = 0;
    step(r, { x: 0, y: 0 });
    expect(r.enemies).toHaveLength(1);
    expect(Math.hypot(r.enemies[0].x - r.player.x, r.enemies[0].y - r.player.y)).toBeGreaterThan(240);
    expect(restore(serialize(r))).toEqual({ ...r, effects: [] });
  }
  const r = freshRun(9); r.enemies = []; r.spawn = 10;
  for (let i = 0; i < 150; i++) step(r, { x: 1, y: 0 });
  expect(r.player.x).toBeGreaterThan(W); expect(r.player.x).toBeLessThanOrEqual(WORLD_W - 22);
});
