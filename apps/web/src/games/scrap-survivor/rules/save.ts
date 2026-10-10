import { canEvolve, canUpgrade, EVOLUTION_KEYS, EVOLUTIONS, UPGRADE_KEYS, UPGRADES, weaponCount } from "./catalog";
import { ELITE_TIMES, H, W, WEAPON_SLOTS, WORLD_H, WORLD_W, type Point, type Run, type Upgrade } from "./model";
import { freshRun } from "./simulation";
import { baseRig, maxHull, missionComplete, RELAY_SECONDS, ROBOT_KEYS, SECTOR_KEYS, WORKSHOP_CAP, WORKSHOP_KEYS } from "./campaign-catalog";

// Old clients cannot overwrite campaign progress with their run-only snapshots.
export const LEGACY_SAVE_KEY = "game:scrap-survivor:v1";
export const SAVE_KEY = "game:scrap-survivor:campaign:v1";
export function serialize(r: Run) { return JSON.stringify({ ...r, effects: [] }); }
export function restore(raw: string | null): Run {
  try {
    if (!raw || raw.length > 180_000) return freshRun();
    const parsed = JSON.parse(raw);
    if (!parsed || ![1, 2, 3, 4, 5].includes(parsed.version)) return freshRun();
    const legacyWorld = parsed.version === 1;
    if (parsed.version < 3) {
      parsed.upgrades = { ...parsed.upgrades, mine: 0, drone: 0 };
      Object.assign(parsed, { version: 3, mine: 0, drone: 0, mines: [], chests: [], rewards: [],
        evolutions: { bolt: false, blade: false, arc: false }, elitesCleared: 0,
        eliteWave: ELITE_TIMES.filter(time => time <= parsed.time).length });
    }
    if (parsed.version === 3) Object.assign(parsed, { version: 4, rig: baseRig(), relays: [], hazards: [], hazardClock: 0, wardenDefeated: parsed.won });
    if (parsed.version === 4) {
      parsed.version = 5;
      parsed.evolutions = { ...parsed.evolutions, mine: false, drone: false };
    }
    delete parsed.campaign;
    const r = parsed as Run;
    const finite = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
    const integer = (v: unknown, min: number, max: number) => finite(v, min, max) && Number.isInteger(v);
    const point = (p: Point) => p && finite(p.x, 0, legacyWorld ? W : WORLD_W) && finite(p.y, 0, legacyWorld ? H : WORLD_H);
    const list = (v: unknown, max: number): v is unknown[] => Array.isArray(v) && v.length <= max;
    const upgrade = (v: unknown): v is Upgrade => typeof v === "string" && Object.hasOwn(UPGRADES, v);
    if (!r.rig || !ROBOT_KEYS.includes(r.rig.robot) || !SECTOR_KEYS.includes(r.rig.sector) || !integer(r.rig.mastery, 0, 2)
      || !r.rig.workshop || WORKSHOP_KEYS.some(k => !integer(r.rig.workshop[k], 0, WORKSHOP_CAP))
      || !list(r.relays, 3) || r.relays.some(relay => !point(relay) || !finite(relay.charge, 0, RELAY_SECONDS))
      || !list(r.hazards, 4) || r.hazards.some(h => !point(h) || !finite(h.ttl, 0, 2.4))
      || !finite(r.hazardClock, -1, 12) || typeof r.wardenDefeated !== "boolean" || (r.won && !missionComplete(r))) return freshRun();
    if (!point(r.player) || !integer(r.hull, 0, maxHull(r)) || !finite(r.time, 0, 86400)
      || !integer(r.rng, 0, 4294967295) || !integer(r.id, 0, 1e8) || !finite(r.invulnerable, -86400, 2)
      || !integer(r.level, 1, 10000) || !finite(r.xp, 0, 1e6) || !finite(r.nextXp, 1, 1e6) || !integer(r.kills, 0, 1e7)
      || !integer(r.spawned, 0, 1e7) || typeof r.boss !== "boolean" || typeof r.won !== "boolean"
      || ![r.spawn, r.bolt, r.blade, r.arc, r.mine, r.drone].every(v => finite(v, -86400, 10))
      || !r.upgrades || UPGRADE_KEYS.some(k => !integer(r.upgrades[k], 0, UPGRADES[k].max))
      || weaponCount(r) < 1 || weaponCount(r) > WEAPON_SLOTS || !integer(r.eliteWave, 0, 2) || !integer(r.elitesCleared, 0, r.eliteWave)
      || !r.evolutions || EVOLUTION_KEYS.some(k => typeof r.evolutions[k] !== "boolean"
        || (r.evolutions[k] && (r.upgrades[k] < 5 || r.upgrades[EVOLUTIONS[k].passive] < 1)))
      || !list(r.choices, 3) || new Set(r.choices).size !== r.choices.length || r.choices.some(k => !upgrade(k) || !canUpgrade(r, k))
      || !list(r.enemies, 80) || !list(r.bullets, 180) || !list(r.gems, 121) || !list(r.mines, 18) || !list(r.chests, 2)
      || !list(r.rewards, 3) || (r.choices.length > 0 && r.rewards.length > 0)) return freshRun();
    if (r.enemies.some(e => !point(e) || !integer(e.id, 1, r.id) || !["drone", "charger", "sentry", "elite", "boss"].includes(e.kind)
        || !finite(e.hp, 0, 2000) || !finite(e.max, 1, 2000) || e.hp > e.max || !finite(e.clock, -10, 5) || !finite(e.dash, -1, 1) || !finite(e.dx, -1, 1) || !finite(e.dy, -1, 1))
      || r.bullets.some(b => !point(b) || !integer(b.id, 1, r.id) || !finite(b.vx, -400, 400) || !finite(b.vy, -400, 400) || !finite(b.ttl, 0, 5)
        || !finite(b.damage, 0, 40) || typeof b.hostile !== "boolean" || !integer(b.pierce, -1, 3) || !list(b.hit, 5)
        || b.hit.some(id => !integer(id, 1, r.id)) || (b.kind !== undefined && b.kind !== "bolt" && b.kind !== "drone" && b.kind !== "missile")
        || (b.kind === "missile" && (b.hostile || !r.evolutions.drone || b.pierce !== 0)))
      || r.gems.some(g => !point(g) || !integer(g.id, 1, r.id) || !finite(g.value, 1, 1e6))
      || r.mines.some(m => !point(m) || !integer(m.id, 1, r.id) || !finite(m.ttl, 0, 9) || !finite(m.arm, -10, 0.3)
        || (m.fuse !== undefined && (!r.evolutions.mine || !finite(m.fuse, 0, 0.65))))
      || r.chests.some(c => !point(c) || !integer(c.id, 1, r.id))) return freshRun();
    if (r.rewards.some(reward => !reward || (reward.kind === "evolve" ? !EVOLUTION_KEYS.includes(reward.weapon) || !canEvolve(r, reward.weapon)
      : reward.kind === "upgrade" ? !upgrade(reward.upgrade) || !r.upgrades[reward.upgrade] || !canUpgrade(r, reward.upgrade)
      : reward.kind !== "repair")) || new Set(r.rewards.map(reward => JSON.stringify(reward))).size !== r.rewards.length) return freshRun();
    const entities = [...r.enemies, ...r.bullets, ...r.gems, ...r.mines, ...r.chests];
    if (new Set(entities.map(e => e.id)).size !== entities.length) return freshRun();
    if (legacyWorld) for (const p of [r.player, ...entities]) { p.x += (WORLD_W - W) / 2; p.y += (WORLD_H - H) / 2; }
    r.effects = []; return r;
  } catch { return freshRun(); }
}
