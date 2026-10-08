/** Fixed-step survival simulation. Wall-clock time and agent activity never advance a saved run. */
export const W = 480, H = 640, STEP = 1 / 30, SAVE_KEY = "game:scrap-survivor:v1";
export const WORLD_W = W * 3, WORLD_H = H * 3, PLAYER_SCREEN_Y = H * 0.42;
export type Point = { x: number; y: number };
export type Upgrade = "bolt" | "blade" | "arc" | "reactor" | "magnet" | "boots";
export const UPGRADES: Record<Upgrade, { name: string; detail: string; max: number }> = {
  bolt: { name: "Bolt launcher", detail: "More damage. Triple fire at Lv 3; piercing fan at Lv 5.", max: 5 },
  blade: { name: "Orbiting blades", detail: "Circling cutters clear a path. Wider orbit and more blades with each level.", max: 5 },
  arc: { name: "Chain lightning", detail: "Electric arcs jump between enemies. More jumps with each level.", max: 5 },
  reactor: { name: "Overcharged core", detail: "All weapons deal more damage. Restore 2 hull.", max: 3 },
  magnet: { name: "Scrap magnet", detail: "Collect scrap from farther away. Restore 2 hull.", max: 3 },
  boots: { name: "Turbo treads", detail: "Move faster through gaps. Restore 2 hull.", max: 3 },
};
export type Enemy = Point & { id: number; kind: "drone" | "charger" | "sentry" | "boss"; hp: number; max: number; clock: number; dash: number; dx: number; dy: number };
export type Bullet = Point & { id: number; vx: number; vy: number; ttl: number; damage: number; hostile: boolean; pierce: number; hit: number[] };
export type Gem = Point & { id: number; value: number };
export type Effect = Point & { kind: "hit" | "kill" | "arc"; ttl: number; value: number; from?: Point };
export type Run = {
  version: 1 | 2; rng: number; id: number; time: number; hull: number; player: Point; invulnerable: number;
  level: number; xp: number; nextXp: number; kills: number; upgrades: Record<Upgrade, number>;
  spawn: number; spawned: number; bolt: number; blade: number; arc: number; boss: boolean; won: boolean;
  enemies: Enemy[]; bullets: Bullet[]; gems: Gem[]; choices: Upgrade[]; effects: Effect[];
};
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
function random(r: Run) { r.rng = (Math.imul(r.rng, 1664525) + 1013904223) >>> 0; return r.rng / 4294967296; }
export function freshRun(seed = Math.floor(Math.random() * 4294967295)): Run {
  const r: Run = { version: 2, rng: seed >>> 0, id: 0, time: 0, hull: 8, player: { x: WORLD_W / 2, y: WORLD_H / 2 }, invulnerable: 1.5,
    level: 1, xp: 0, nextXp: 24, kills: 0, upgrades: { bolt: 1, blade: 0, arc: 0, reactor: 0, magnet: 0, boots: 0 },
    spawn: 1, spawned: 0, bolt: 0, blade: 0, arc: 0, boss: false, won: false, enemies: [], bullets: [], gems: [], choices: [], effects: [] };
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
  const hp = kind === "boss" ? 800 : (kind === "drone" ? 3 : kind === "charger" ? 6 : 9) + Math.floor(r.time / 60) * 2;
  r.enemies.push({ ...point, id: ++r.id, kind, hp, max: hp, clock: 1.5 + random(r), dash: 0, dx: 0, dy: 0 });
  r.spawned++;
}
function damage(r: Run, enemy: Enemy, amount: number) {
  if (enemy.hp <= 0) return;
  enemy.hp = Math.max(0, enemy.hp - amount);
  r.effects.push({ x: enemy.x, y: enemy.y, kind: enemy.hp ? "hit" : "kill", ttl: 0.4, value: Math.ceil(amount) });
  if (!enemy.hp) {
    r.kills++; r.gems.push({ x: enemy.x, y: enemy.y, id: ++r.id, value: enemy.kind === "boss" ? 40 : 4 });
    if (enemy.kind === "boss") r.won = true;
  }
}
function hitPlayer(r: Run) { if (r.invulnerable <= 0) { r.hull = Math.max(0, r.hull - 1); r.invulnerable = 0.85; } }
function projectile(r: Run, from: Point, angle: number, hostile = false, damage = 1, pierce = 0) {
  const speed = hostile ? 125 : 390;
  r.bullets.push({ ...from, id: ++r.id, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, ttl: hostile ? 5 : 2, damage, hostile, pierce, hit: [] });
}
export function chooseUpgrade(r: Run, choice: Upgrade): boolean {
  if (!r.choices.includes(choice) || r.hull <= 0 || r.won) return false;
  r.upgrades[choice]++; r.hull = Math.min(8, r.hull + (UPGRADES[choice].max === 3 ? 2 : 1));
  r.choices = []; r.invulnerable = 1;
  return true;
}
/** Mutates only this run; callers keep UI snapshots separate from its 30 Hz simulation. */
export function step(r: Run, movement: Point) {
  if (r.hull <= 0 || r.won || r.choices.length) return;
  r.time += STEP; r.invulnerable -= STEP;
  const mx = Number.isFinite(movement.x) ? movement.x : 0, my = Number.isFinite(movement.y) ? movement.y : 0;
  const length = Math.max(1, Math.hypot(mx, my)), speed = 145 + r.upgrades.boots * 22;
  r.player.x = clamp(r.player.x + mx / length * speed * STEP, 22, WORLD_W - 22);
  r.player.y = clamp(r.player.y + my / length * speed * STEP, 22, WORLD_H - 22);
  r.effects = r.effects.filter(e => (e.ttl -= STEP) > 0).slice(-70);
  r.spawn -= STEP;
  if (r.spawn <= 0 && r.enemies.length < 75) {
    r.spawn = Math.max(0.3, 0.95 - r.time / 240);
    const kind = r.time > 35 && r.spawned % 7 === 0 ? "sentry" : r.time > 18 && r.spawned % 4 === 0 ? "charger" : "drone";
    spawn(r, kind);
  }
  if (!r.boss && r.time >= 150) { r.boss = true; spawn(r, "boss"); }
  const nearest = r.enemies.filter(e => e.hp > 0).sort((a, b) => distance(a, r.player) - distance(b, r.player));
  const power = 1 + r.upgrades.reactor * 0.35;
  r.bolt -= STEP;
  if (r.bolt <= 0 && nearest[0]) {
    const lv = r.upgrades.bolt; r.bolt = Math.max(0.24, 0.65 - lv * 0.06);
    const a = Math.atan2(nearest[0].y - r.player.y, nearest[0].x - r.player.x), count = lv >= 5 ? 5 : lv >= 3 ? 3 : 1;
    for (let i = 0; i < count; i++) projectile(r, r.player, a + (i - (count - 1) / 2) * 0.16, false, (1 + lv) * power, lv >= 5 ? 3 : 0);
  }
  r.blade -= STEP;
  if (r.upgrades.blade && r.blade <= 0) {
    r.blade = 0.32;
    for (const enemy of nearest) if (distance(enemy, r.player) < 42 + r.upgrades.blade * 9) damage(r, enemy, (1 + r.upgrades.blade * 0.65) * power);
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
    }
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
    if (e.kind === "sentry" || e.kind === "boss") {
      if (d < 170) velocity = 0;
      if (e.clock <= 0) {
        e.clock = e.kind === "boss" ? 1.7 : 2.8;
        const angle = Math.atan2(dy, dx), count = e.kind === "boss" ? 9 : 1;
        for (let i = 0; i < count; i++) projectile(r, e, angle + (i - (count - 1) / 2) * 0.22, true);
      }
    }
    e.x = clamp(e.x + dx * velocity * STEP, 12, WORLD_W - 12); e.y = clamp(e.y + dy * velocity * STEP, 12, WORLD_H - 12);
    if (distance(e, r.player) < (e.kind === "boss" ? 38 : 23)) hitPlayer(r);
  }
  for (const b of r.bullets) {
    b.x += b.vx * STEP; b.y += b.vy * STEP; b.ttl -= STEP;
    if (b.hostile) { if (distance(b, r.player) < 16) { hitPlayer(r); b.ttl = 0; } }
    else for (const e of r.enemies) if (e.hp > 0 && !b.hit.includes(e.id) && distance(b, e) < (e.kind === "boss" ? 34 : 19)) {
      damage(r, e, b.damage); b.hit.push(e.id); if (b.pierce-- <= 0) { b.ttl = 0; break; }
    }
  }
  r.enemies = r.enemies.filter(e => e.hp > 0);
  r.bullets = r.bullets.filter(b => b.ttl > 0 && b.x > 0 && b.x < WORLD_W && b.y > 0 && b.y < WORLD_H).slice(-180);
  for (const g of r.gems) {
    const d = distance(g, r.player), radius = 55 + r.upgrades.magnet * 35;
    if (d < radius) { const fraction = Math.min(1, 330 * STEP / (d || 1)); g.x += (r.player.x - g.x) * fraction; g.y += (r.player.y - g.y) * fraction; }
    if (distance(g, r.player) < 18) { r.xp += g.value; g.value = 0; }
  }
  r.gems = r.gems.filter(g => g.value > 0);
  // Merge distant pickups instead of growing the saved run without a bound.
  while (r.gems.length > 120) { r.gems[1].value += r.gems[0].value; r.gems.shift(); }
  if (r.xp >= r.nextXp && r.hull > 0 && !r.won) {
    r.xp -= r.nextXp; r.level++; r.nextXp = 16 + r.level * 8;
    const available = (Object.keys(UPGRADES) as Upgrade[]).filter(k => r.upgrades[k] < UPGRADES[k].max);
    if (r.level === 2) r.choices = ["blade", "arc", "bolt"];
    else {
      for (let i = available.length - 1; i > 0; i--) { const j = Math.floor(random(r) * (i + 1)); [available[i], available[j]] = [available[j], available[i]]; }
      r.choices = available.slice(0, 3);
      if (!r.choices.length) r.hull = Math.min(8, r.hull + 2);
    }
  }
}
export function serialize(r: Run) { return JSON.stringify({ ...r, effects: [] }); }
export function restore(raw: string | null): Run {
  try {
    if (!raw || raw.length > 180_000) return freshRun();
    const r = JSON.parse(raw) as Run;
    const finite = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
    const point = (p: Point) => p && finite(p.x, 0, r.version === 1 ? W : WORLD_W) && finite(p.y, 0, r.version === 1 ? H : WORLD_H);
    const list = (v: unknown, max: number): v is unknown[] => Array.isArray(v) && v.length <= max;
    if ((r.version !== 1 && r.version !== 2) || !point(r.player) || !finite(r.hull, 0, 8) || !finite(r.time, 0, 86400)
      || !Number.isInteger(r.rng) || !finite(r.rng, 0, 4294967295) || !finite(r.id, 0, 1e8) || !finite(r.invulnerable, -86400, 2)
      || !finite(r.level, 1, 10000) || !finite(r.xp, 0, 1e6) || !finite(r.nextXp, 1, 1e6) || !finite(r.kills, 0, 1e7)
      || !finite(r.spawned, 0, 1e7) || typeof r.boss !== "boolean" || typeof r.won !== "boolean"
      || ![r.spawn, r.bolt, r.blade, r.arc].every(v => finite(v, -86400, 10))
      || !r.upgrades || (Object.keys(UPGRADES) as Upgrade[]).some(k => !Number.isInteger(r.upgrades[k]) || !finite(r.upgrades[k], k === "bolt" ? 1 : 0, UPGRADES[k].max))
      || !list(r.choices, 3) || new Set(r.choices).size !== r.choices.length || r.choices.some(k => !Object.hasOwn(UPGRADES, k) || r.upgrades[k] >= UPGRADES[k].max)
      || !list(r.enemies, 76) || !list(r.bullets, 180) || !list(r.gems, 121)) return freshRun();
    if (r.enemies.some(e => !point(e) || !finite(e.id, 1, r.id) || !["drone", "charger", "sentry", "boss"].includes(e.kind) || !finite(e.hp, 0, 1000) || !finite(e.max, 1, 1000) || e.hp > e.max || !finite(e.clock, -10, 5) || !finite(e.dash, -1, 1) || !finite(e.dx, -1, 1) || !finite(e.dy, -1, 1))
      || r.bullets.some(b => !point(b) || !finite(b.id, 1, r.id) || !finite(b.vx, -400, 400) || !finite(b.vy, -400, 400) || !finite(b.ttl, 0, 5) || !finite(b.damage, 0, 30) || typeof b.hostile !== "boolean" || !finite(b.pierce, -1, 3) || !list(b.hit, 5) || b.hit.some(id => !finite(id, 1, r.id)))
      || r.gems.some(g => !point(g) || !finite(g.id, 1, r.id) || !finite(g.value, 1, 1e6))) return freshRun();
    // Preserve positions relative to one another when expanding a legacy arena.
    if (r.version === 1) {
      for (const p of [r.player, ...r.enemies, ...r.bullets, ...r.gems]) { p.x += (WORLD_W - W) / 2; p.y += (WORLD_H - H) / 2; }
      r.version = 2;
    }
    r.effects = []; return r;
  } catch { return freshRun(); }
}
