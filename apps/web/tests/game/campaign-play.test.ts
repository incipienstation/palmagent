import { test } from "node:test";
import assert from "node:assert/strict";
import { freshRun, step, chooseUpgrade, chooseReward, nearestRelay, restore, serialize, SECTOR_KEYS, ROBOT_KEYS,
  WORLD_W, WORLD_H, type Run, type Upgrade } from "../../src/games/scrap-survivor/engine";

// A fixed policy exercises complete earned builds. It has no immunity, free levels, or direct damage.
function steer(r: Run) {
  const relay = nearestRelay(r);
  const target = relay && (r.time < 40 || r.wardenDefeated) ? relay : [...r.chests, ...r.gems]
    .sort((a, b) => Math.hypot(a.x - r.player.x, a.y - r.player.y) - Math.hypot(b.x - r.player.x, b.y - r.player.y))[0];
  let x = Math.cos(r.time / 5), y = Math.sin(r.time / 5);
  if (target) {
    const d = Math.hypot(target.x - r.player.x, target.y - r.player.y) || 1, hold = target === relay && d < 38;
    x = hold ? 0 : (target.x - r.player.x) / d; y = hold ? 0 : (target.y - r.player.y) / d;
  }
  // Melee starters must enter blade range; ranged builds maintain more space.
  const safe = r.upgrades.blade && !r.upgrades.bolt && !r.upgrades.arc && !r.upgrades.drone ? 42 : 85;
  for (const e of r.enemies) {
    const dx = r.player.x - e.x, dy = r.player.y - e.y, d = Math.hypot(dx, dy) || 1;
    if (d < safe) { x += dx / d * (safe - d) / 20; y += dy / d * (safe - d) / 20; }
  }
  for (const b of r.bullets) {
    if (!b.hostile) continue;
    const dx = r.player.x - b.x, dy = r.player.y - b.y, d = Math.hypot(dx, dy) || 1;
    if (d < 65 && dx * b.vx + dy * b.vy > 0) {
      const sign = dx * -b.vy + dy * b.vx >= 0 ? 1 : -1;
      x += -b.vy / 125 * sign * (65 - d) / 25; y += b.vx / 125 * sign * (65 - d) / 25;
    }
  }
  for (const h of r.hazards) {
    const dx = r.player.x - h.x, dy = r.player.y - h.y, d = Math.hypot(dx, dy) || 1;
    if (d < 85) { x += (dx || 1) / d * 4; y += dy / d * 4; }
  }
  if (r.player.x < 55) x += 2; if (r.player.x > WORLD_W - 55) x -= 2;
  if (r.player.y < 55) y += 2; if (r.player.y > WORLD_H - 55) y -= 2;
  return { x, y };
}

test("every robot has a viable earned build in every sector, including relay and Warden completion", t => {
  for (const sector of SECTOR_KEYS) for (const robot of ROBOT_KEYS) {
    let wins = 0, defeats = 0;
    for (const seed of sector === 3 ? [1, 2, 3, 4, 5, 6] : [1, 2]) {
      const r = freshRun(seed, { robot, sector, mastery: 2, workshop: { hull: 3, power: 3, salvage: 3 } });
      for (let frame = 0; frame < 30 * 300 && r.hull > 0 && !r.won; frame++) {
        if (r.choices.length) {
          const preferred: Upgrade[] = robot === "engineer" ? ["drone", "mine", "reactor", "bolt", "magnet", "boots", "blade", "arc"]
            : robot === "bulwark" ? ["blade", "bolt", "reactor", "magnet", "arc", "boots", "mine", "drone"]
            : ["bolt", "reactor", "arc", "boots", "magnet", "mine", "drone", "blade"];
          if (robot === "bulwark" && r.upgrades.boots === 0) preferred.unshift("boots");
          if (r.upgrades.blade >= 4 && r.upgrades.magnet === 0) preferred.unshift("magnet");
          chooseUpgrade(r, preferred.find(k => r.choices.includes(k))!);
        }
        if (r.rewards.length) chooseReward(r, 0);
        step(r, steer(r));
      }
      if (r.won) wins++; if (r.hull <= 0) defeats++;
      assert.deepEqual(restore(serialize(r)), { ...r, effects: [] });
      if (r.won) assert.ok(r.wardenDefeated);
    }
    t.diagnostic(JSON.stringify({ sector, robot, wins, defeats }));
    assert.ok(wins > 0, `${robot} can clear sector ${sector} with earned upgrades`);
  }
});
