import { BOSS_TIME, ELITE_TIMES, H, W, WORLD_W, WORLD_H, PLAYER_SCREEN_Y, STEP, type Point, type Run, type Enemy, type Rig, type Weapon } from "./model";
import { bladeRadius, dronePositions } from "./catalog";
import { baseRig, maxHull, missionComplete, moveSpeed, pickupRadius, RELAY_SECONDS, ROBOTS, SECTORS } from "./campaign-catalog";
import { offerUpgrades, openChest } from "./progression";

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
function random(r: Run) { r.rng = (Math.imul(r.rng, 1664525) + 1013904223) >>> 0; return r.rng / 4294967296; }
export function freshRun(seed = Math.floor(Math.random() * 4294967295), rig: Rig = baseRig(), weapon: Weapon = ROBOTS[rig.robot].weapon): Run {
  const r: Run = { version: 5, rng: seed >>> 0, id: 0, time: 0, hull: maxHull({ rig }), player: { x: WORLD_W / 2, y: WORLD_H / 2 }, invulnerable: 1.5,
    rig: { ...rig, workshop: { ...rig.workshop } }, relays: [], hazards: [], hazardClock: SECTORS[rig.sector].hazardEvery, wardenDefeated: false,
    level: 1, xp: 0, nextXp: 24, kills: 0, upgrades: { bolt: 0, blade: 0, arc: 0, mine: 0, drone: 0, reactor: 0, magnet: 0, boots: 0, [weapon]: 1 },
    spawn: 1, spawned: 0, bolt: 0, blade: 0, arc: 0, mine: 0, drone: 0,
    eliteWave: 0, elitesCleared: 0, evolutions: { bolt: false, blade: false, arc: false, mine: false, drone: false }, rewards: [], chests: [], mines: [], boss: false, won: false, enemies: [], bullets: [], gems: [], choices: [], effects: [] };
  const angle = (seed % 4) * Math.PI / 2;
  r.relays = Array.from({ length: SECTORS[rig.sector].relays }, (_, i) => ({
    x: WORLD_W / 2 + Math.cos(angle + i * Math.PI * 2 / 3) * (260 + i * 80),
    y: WORLD_H / 2 + Math.sin(angle + i * Math.PI * 2 / 3) * (260 + i * 80), charge: 0,
  }));
  for (let i = 0; i < 5; i++) spawn(r, "drone", { x: WORLD_W / 2 + Math.cos(i * 1.256) * 125, y: WORLD_H / 2 + Math.sin(i * 1.256) * 125 });
  return r;
}
function spawn(r: Run, kind: Enemy["kind"], position?: Point) {
  // Spawn just outside the camera, using only edges that are inside the world.
  const n = random(r), left = r.player.x - W / 2 - 32, right = r.player.x + W / 2 + 32;
  const top = r.player.y - PLAYER_SCREEN_Y - 32, bottom = top + H + 64;
  const x = clamp(left + n * (right - left), 18, WORLD_W - 18), y = clamp(top + n * (bottom - top), 18, WORLD_H - 18);
  const edges = [{ x: left, y }, { x: right, y }, { x, y: top }, { x, y: bottom }]
    .filter(p => p.x >= 18 && p.x <= WORLD_W - 18 && p.y >= 18 && p.y <= WORLD_H - 18);
  const point = position ?? edges[Math.floor(random(r) * edges.length)];
  const hp = (kind === "boss" ? 800 : kind === "elite" ? 85 + r.eliteWave * 30 : (kind === "drone" ? 3 : kind === "charger" ? 6 : 9) + Math.floor(r.time / 60) * 2) * SECTORS[r.rig.sector].health;
  r.enemies.push({ ...point, id: ++r.id, kind, hp, max: hp, clock: 1.5 + random(r), dash: 0, dx: 0, dy: 0 });
  r.spawned++;
}
function damage(r: Run, enemy: Enemy, amount: number) {
  if (enemy.hp <= 0) return;
  enemy.hp = Math.max(0, enemy.hp - amount);
  r.effects.push({ x: enemy.x, y: enemy.y, kind: enemy.hp ? "hit" : "kill", ttl: 0.4, value: Math.ceil(amount) });
  if (!enemy.hp) {
    r.kills++; r.gems.push({ x: enemy.x, y: enemy.y, id: ++r.id, value: enemy.kind === "boss" ? 40 : enemy.kind === "elite" ? 20 : 4 });
    if (enemy.kind === "boss") { r.wardenDefeated = true; r.won = missionComplete(r); }
    if (enemy.kind === "elite") { r.elitesCleared++; r.chests.push({ x: enemy.x, y: enemy.y, id: ++r.id }); }
  }
}
function hitPlayer(r: Run) { if (r.invulnerable <= 0) { r.hull = Math.max(0, r.hull - 1); r.invulnerable = 0.85; } }
function projectile(r: Run, from: Point, angle: number, hostile = false, damage = 1, pierce = 0, kind: "bolt" | "drone" | "missile" = "bolt") {
  const speed = hostile ? 125 : kind === "missile" ? 240 : 390;
  r.bullets.push({ ...from, id: ++r.id, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, ttl: hostile ? 5 : 2, damage, hostile, pierce, hit: [], kind });
}
/** Mutates only this run; callers keep UI snapshots separate from its 30 Hz simulation. */
export function step(r: Run, movement: Point) {
  if (r.hull <= 0 || r.won || r.choices.length || r.rewards.length) return;
  r.time += STEP; r.invulnerable -= STEP;
  const mx = Number.isFinite(movement.x) ? movement.x : 0, my = Number.isFinite(movement.y) ? movement.y : 0;
  const length = Math.max(1, Math.hypot(mx, my)), speed = moveSpeed(r);
  r.player.x = clamp(r.player.x + mx / length * speed * STEP, 22, WORLD_W - 22);
  r.player.y = clamp(r.player.y + my / length * speed * STEP, 22, WORLD_H - 22);
  r.effects = r.effects.filter(e => (e.ttl -= STEP) > 0).slice(-100);
  const sector = SECTORS[r.rig.sector];
  for (const relay of r.relays) {
    if (relay.charge >= RELAY_SECONDS || distance(relay, r.player) > 58) continue;
    relay.charge = Math.min(RELAY_SECONDS, relay.charge + STEP);
    if (relay.charge >= RELAY_SECONDS) { r.xp += 20; r.hull = Math.min(maxHull(r), r.hull + 1); }
  }
  if (missionComplete(r)) { r.won = true; return; }
  if (sector.hazardEvery) {
    r.hazardClock -= STEP;
    if (r.hazardClock <= 0) {
      r.hazardClock = sector.hazardEvery;
      r.hazards.push({ ...r.player, ttl: 2.4 });
      if (r.rig.sector === 3) r.hazards.push({ x: clamp(r.player.x + (mx || my ? mx / length : 1) * 95, 55, WORLD_W - 55), y: clamp(r.player.y + my / length * 95, 55, WORLD_H - 55), ttl: 2.4 });
    }
  }
  for (const hazard of r.hazards) {
    hazard.ttl -= STEP;
    if (hazard.ttl <= 0.9 && hazard.ttl > 0 && distance(hazard, r.player) < 55) hitPlayer(r);
  }
  r.hazards = r.hazards.filter(h => h.ttl > 0).slice(-4);
  if (r.hull <= 0) return;
  r.spawn -= STEP;
  if (r.spawn <= 0 && r.enemies.length < 75) {
    r.spawn = Math.max(0.3, 0.95 - r.time / 240) / sector.pressure;
    const kind = r.rig.sector === 3 && r.time > 25 && r.spawned % 4 === 0 ? "sentry"
      : r.rig.sector >= 2 && r.time > 15 && r.spawned % 3 === 1 ? "charger"
      : r.time > 35 && r.spawned % (r.rig.sector >= 2 ? 5 : 7) === 0 ? "sentry" : r.time > 18 && r.spawned % 4 === 0 ? "charger" : "drone";
    spawn(r, kind);
  }
  if (r.eliteWave < ELITE_TIMES.length && r.time >= ELITE_TIMES[r.eliteWave]) { r.eliteWave++; spawn(r, "elite"); }
  if (!r.boss && r.time >= BOSS_TIME) { r.boss = true; spawn(r, "boss"); }
  const nearest = r.enemies.filter(e => e.hp > 0).sort((a, b) => distance(a, r.player) - distance(b, r.player));
  const power = (1 + r.upgrades.reactor * 0.35) * (1 + r.rig.workshop.power * 0.08);
  const engineering = r.rig.robot === "engineer" ? 1.25 : 1;
  r.bolt -= STEP;
  if (r.upgrades.bolt && r.bolt <= 0 && nearest[0]) {
    const lv = r.upgrades.bolt; r.bolt = r.evolutions.bolt ? 0.7 : Math.max(0.24, 0.65 - lv * 0.06);
    const a = Math.atan2(nearest[0].y - r.player.y, nearest[0].x - r.player.x), count = lv >= 5 ? 5 : lv >= 3 ? 3 : 1;
    if (r.evolutions.bolt) {
      const dx = Math.cos(a), dy = Math.sin(a), reach = 420;
      r.effects.push({ kind: "rail", from: { ...r.player }, x: r.player.x + dx * reach, y: r.player.y + dy * reach, ttl: 0.25, value: 0 });
      for (const e of nearest) {
        const ex = e.x - r.player.x, ey = e.y - r.player.y, along = ex * dx + ey * dy;
        if (along >= 0 && along <= reach && Math.abs(ex * dy - ey * dx) < (e.kind === "boss" ? 40 : 24)) damage(r, e, 38 * power);
      }
    } else for (let i = 0; i < count; i++) projectile(r, r.player, a + (i - (count - 1) / 2) * 0.16, false, (1 + lv) * power, lv >= 5 ? 3 : 0);
  }
  r.blade -= STEP;
  if (r.upgrades.blade && r.blade <= 0) {
    r.blade = 0.32;
    for (const enemy of nearest) if (distance(enemy, r.player) < bladeRadius(r)) damage(r, enemy, (1 + r.upgrades.blade * 0.65) * power * (r.evolutions.blade ? 1.7 : 1));
  }
  r.arc -= STEP;
  if (r.upgrades.arc && r.arc <= 0 && nearest[0] && distance(nearest[0], r.player) < 200) {
    r.arc = Math.max(0.55, 1.4 - r.upgrades.arc * 0.12);
    let from: Point = r.player;
    const visited = new Set<number>();
    for (let i = 0; i <= r.upgrades.arc; i++) {
      const target = r.enemies.filter(e => e.hp > 0 && !visited.has(e.id) && distance(e, from) < 200).sort((a, b) => distance(a, from) - distance(b, from))[0];
      if (!target) break;
      r.effects.push({ x: target.x, y: target.y, from: { ...from }, kind: "arc", ttl: 0.2, value: 0 });
      damage(r, target, (2 + r.upgrades.arc) * power); visited.add(target.id); from = target;
      if (r.evolutions.arc) {
        r.effects.push({ kind: "storm", x: target.x, y: target.y, ttl: 0.4, value: 0, radius: 60 });
        for (const e of r.enemies) if (e !== target && e.hp > 0 && distance(e, target) < 60) damage(r, e, 4 * power);
      }
    }
  }
  r.mine -= STEP; r.drone -= STEP;
  if (r.upgrades.mine && r.mine <= 0) {
    r.mine = r.evolutions.mine ? 1.8 : 2.2 - r.upgrades.mine * 0.2;
    r.mines.push({ ...r.player, id: ++r.id, ttl: 9, arm: 0.3 });
  }
  for (const mine of r.mines) {
    mine.ttl -= STEP; mine.arm -= STEP;
    if (mine.arm > 0 || mine.ttl <= 0) continue;
    const evolved = r.evolutions.mine;
    if (mine.fuse === undefined) {
      if (!r.enemies.some(e => e.hp > 0 && distance(e, mine) < (evolved ? 45 : 32))) continue;
      if (evolved) mine.fuse = 0.65;
    }
    if (mine.fuse !== undefined) {
      mine.fuse = Math.max(0, mine.fuse - STEP);
      for (const e of r.enemies) {
        const d = distance(e, mine);
        if (e.hp <= 0 || e.kind === "boss" || d <= 12 || d >= 120) continue;
        const fraction = Math.min((d - 12) / d, 110 * STEP / d);
        e.x += (mine.x - e.x) * fraction; e.y += (mine.y - e.y) * fraction;
      }
      if (mine.fuse > 0) continue;
    }
    const radius = evolved ? 115 : 60 + r.upgrades.mine * 5;
    r.effects.push({ kind: evolved ? "implosion" : "blast", x: mine.x, y: mine.y, ttl: 0.4, value: 0, radius });
    const mastery = r.rig.robot === "engineer" && r.rig.mastery >= 2 ? 1.25 : 1;
    for (const e of r.enemies) if (e.hp > 0 && distance(e, mine) < radius) damage(r, e, (evolved ? 32 : 7 + r.upgrades.mine * 3) * power * engineering * mastery);
    mine.ttl = 0;
  }
  r.mines = r.mines.filter(m => m.ttl > 0).slice(-18);
  if (r.upgrades.drone && r.drone <= 0) {
    r.drone = r.evolutions.drone ? 0.85 : 0.9 - r.upgrades.drone * 0.08;
    dronePositions(r).forEach((position, i) => {
      const targets = r.enemies.filter(e => e.hp > 0).sort((a, b) => distance(a, position) - distance(b, position));
      const target = targets[i % Math.max(1, targets.length)];
      if (target) projectile(r, position, Math.atan2(target.y - position.y, target.x - position.x), false, (r.evolutions.drone ? 12 : 1.5 + r.upgrades.drone) * power * engineering, 0, r.evolutions.drone ? "missile" : "drone");
    });
  }
  for (const e of r.enemies) {
    if (e.hp <= 0) continue;
    const d = distance(e, r.player) || 1, dx = (r.player.x - e.x) / d, dy = (r.player.y - e.y) / d;
    e.clock = Math.max(-1, e.clock - STEP);
    let velocity = e.kind === "drone" ? 35 + r.time / 12 : e.kind === "boss" ? 25 : 30;
    if (e.kind === "charger") {
      if (e.dash > 0) { e.dash -= STEP; e.x += e.dx * 235 * STEP; e.y += e.dy * 235 * STEP; velocity = 0; }
      else if (e.clock <= 0) { e.dash = 0.5; e.clock = 3; e.dx = dx; e.dy = dy; velocity = 0; }
      else if (e.clock < 0.65) velocity = 0;
    }
    if (e.kind === "sentry" || e.kind === "elite" || e.kind === "boss") {
      if (d < 170) velocity = 0;
      if (e.clock <= 0) {
        e.clock = (e.kind === "boss" ? 1.7 : e.kind === "elite" ? 2.4 : 2.8) / (r.rig.sector === 3 ? 1.2 : 1);
        const angle = Math.atan2(dy, dx), count = e.kind === "boss" ? 7 + r.rig.sector * 2 : e.kind === "elite" ? 8 : r.rig.sector === 3 && r.time > 60 ? 3 : 1;
        for (let i = 0; i < count; i++) projectile(r, e, angle + (e.kind === "elite" ? i * Math.PI / 4 : (i - (count - 1) / 2) * 0.22), true);
      }
    }
    if (r.evolutions.blade && e.kind !== "boss" && d > 32 && d < bladeRadius(r) + 35) velocity += 70;
    e.x = clamp(e.x + dx * velocity * STEP, 12, WORLD_W - 12); e.y = clamp(e.y + dy * velocity * STEP, 12, WORLD_H - 12);
    if (distance(e, r.player) < (e.kind === "boss" ? 38 : 23)) hitPlayer(r);
  }
  for (const b of r.bullets) {
    b.x += b.vx * STEP; b.y += b.vy * STEP; b.ttl -= STEP;
    if (b.hostile) { if (distance(b, r.player) < 16) { hitPlayer(r); b.ttl = 0; } }
    else for (const e of r.enemies) if (e.hp > 0 && !b.hit.includes(e.id) && distance(b, e) < (e.kind === "boss" ? 34 : 19)) {
      if (b.kind === "missile") {
        r.effects.push({ kind: "missile", x: b.x, y: b.y, ttl: 0.4, value: 0, radius: 65 });
        for (const target of r.enemies) if (target.hp > 0 && distance(target, b) < 65) damage(r, target, b.damage);
        b.ttl = 0; break;
      }
      damage(r, e, b.damage); b.hit.push(e.id); if (b.pierce-- <= 0) { b.ttl = 0; break; }
    }
  }
  r.enemies = r.enemies.filter(e => e.hp > 0);
  r.bullets = r.bullets.filter(b => b.ttl > 0 && b.x > 0 && b.x < WORLD_W && b.y > 0 && b.y < WORLD_H).slice(-180);
  for (const g of r.gems) {
    const d = distance(g, r.player), radius = pickupRadius(r);
    if (d < radius) { const fraction = Math.min(1, 330 * STEP / (d || 1)); g.x += (r.player.x - g.x) * fraction; g.y += (r.player.y - g.y) * fraction; }
    if (distance(g, r.player) < 18) { r.xp += g.value; g.value = 0; }
  }
  r.gems = r.gems.filter(g => g.value > 0);
  // Merge distant pickups instead of growing the saved run without a bound.
  while (r.gems.length > 120) { r.gems[1].value += r.gems[0].value; r.gems.shift(); }
  if (r.xp >= r.nextXp && r.hull > 0 && !r.won) {
    r.xp -= r.nextXp; r.level++; r.nextXp = 16 + r.level * 8;
    offerUpgrades(r, () => random(r));
  }
  if (!r.choices.length && r.hull > 0 && !r.won) {
    const chest = r.chests.find(c => distance(c, r.player) <= 32);
    if (chest) openChest(r, chest.id);
  }

}
