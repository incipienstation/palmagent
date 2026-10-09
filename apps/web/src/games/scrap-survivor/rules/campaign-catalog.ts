import type { Rig, Robot, Run, Sector, Weapon, Workshop } from "./model";

export const ROBOTS: Record<Robot, { name: string; hull: number; speed: number; weapon: Weapon; alternate: Weapon; unlock: number; trait: string; mastery: string }> = {
  scout: { name: "Scout", hull: 8, speed: 165, weapon: "bolt", alternate: "arc", unlock: 0,
    trait: "Fast treads and a wider scrap pickup range.", mastery: "Recovery field: +25 more scrap pickup range." },
  bulwark: { name: "Bulwark", hull: 11, speed: 120, weapon: "blade", alternate: "bolt", unlock: 40,
    trait: "Heavy armor: 11 base HP, but slower movement.", mastery: "Field repair: recover 1 extra HP with every equipment upgrade." },
  engineer: { name: "Engineer", hull: 7, speed: 145, weapon: "drone", alternate: "mine", unlock: 100,
    trait: "Drone and mine damage +25%, but only 7 base HP.", mastery: "Overclock: one extra support drone; mine damage +25% more." },
};
export const ROBOT_KEYS = Object.keys(ROBOTS) as Robot[];
export const SECTORS: Record<Sector, { name: string; detail: string; relays: number; required: number; health: number; pressure: number; hazardEvery: number }> = {
  1: { name: "Scrapyard", detail: "Defeat the Warden. Restore an optional relay for extra salvage.", relays: 1, required: 0, health: 1, pressure: 1, hazardEvery: 0 },
  2: { name: "Foundry", detail: "Restore 1 relay and defeat the Warden. More chargers and sentries; avoid marked heat vents.", relays: 2, required: 1, health: 1.3, pressure: 1.18, hazardEvery: 12 },
  3: { name: "Stormworks", detail: "Restore 2 relays and defeat the Warden. Dense sentry patrols, faster volleys and twin storm strikes.", relays: 3, required: 2, health: 1.5, pressure: 1.3, hazardEvery: 9 },
};
export const SECTOR_KEYS: readonly Sector[] = [1, 2, 3];
export const WORKSHOP: Record<Workshop, { name: string; detail: string }> = {
  hull: { name: "Hull plating", detail: "+1 maximum HP per level" },
  power: { name: "Weapon tuning", detail: "+8% weapon damage per level" },
  salvage: { name: "Salvage rig", detail: "+10% recovered parts per level" },
};
export const WORKSHOP_KEYS = Object.keys(WORKSHOP) as Workshop[];
export const WORKSHOP_CAP = 3, RELAY_SECONDS = 5;
export const workshopCost = (level: number) => 20 * (level + 1);
export const masteryRank = (points: number) => points >= 90 ? 2 : points >= 30 ? 1 : 0;
export const baseRig = (): Rig => ({ robot: "scout", sector: 1, mastery: 0, workshop: { hull: 0, power: 0, salvage: 0 } });
export const maxHull = (r: Pick<Run, "rig">) => ROBOTS[r.rig.robot].hull + r.rig.workshop.hull;
export const moveSpeed = (r: Pick<Run, "rig" | "upgrades">) => ROBOTS[r.rig.robot].speed + r.upgrades.boots * 22;
export const pickupRadius = (r: Pick<Run, "rig" | "upgrades">) => 55 + r.upgrades.magnet * 35 + (r.rig.robot === "scout" ? 15 + (r.rig.mastery >= 2 ? 25 : 0) : 0);
export const repairBonus = (r: Pick<Run, "rig">) => r.rig.robot === "bulwark" && r.rig.mastery >= 2 ? 1 : 0;
export const relaysRestored = (r: Pick<Run, "relays">) => r.relays.filter(relay => relay.charge >= RELAY_SECONDS).length;
export const missionComplete = (r: Pick<Run, "rig" | "relays" | "wardenDefeated">) => r.wardenDefeated && relaysRestored(r) >= SECTORS[r.rig.sector].required;
export function nearestRelay(r: Pick<Run, "relays" | "player">) {
  return r.relays.filter(relay => relay.charge < RELAY_SECONDS)
    .sort((a, b) => Math.hypot(a.x - r.player.x, a.y - r.player.y) - Math.hypot(b.x - r.player.x, b.y - r.player.y))[0];
}
