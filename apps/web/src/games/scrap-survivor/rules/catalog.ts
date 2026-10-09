import { WEAPON_SLOTS, type EvolvingWeapon, type Passive, type Run, type Upgrade, type Weapon } from "./model";

export const WEAPONS: readonly Weapon[] = ["bolt", "blade", "arc", "mine", "drone"];
export const PASSIVES: readonly Passive[] = ["reactor", "magnet", "boots"];
export const UPGRADES: Record<Upgrade, { name: string; detail: string; max: number }> = {
  bolt: { name: "Bolt launcher", detail: "Triple fire at Lv 3; piercing fan at Lv 5.", max: 5 },
  blade: { name: "Orbiting blades", detail: "Circling cutters clear a path. Wider orbit with each level.", max: 5 },
  arc: { name: "Chain lightning", detail: "Electric arcs jump between enemies. More jumps with each level.", max: 5 },
  mine: { name: "Scrap mines", detail: "Leave proximity mines behind and lead enemies into the blast.", max: 5 },
  drone: { name: "Support drones", detail: "Orbiting companions fire at nearby targets. More drones at Lv 3 and 5.", max: 5 },
  reactor: { name: "Overcharged core", detail: "All weapons deal more damage. Restore 2 hull.", max: 3 },
  magnet: { name: "Scrap magnet", detail: "Collect scrap from farther away. Restore 2 hull.", max: 3 },
  boots: { name: "Turbo treads", detail: "Move faster through gaps. Restore 2 hull.", max: 3 },
};
export const UPGRADE_KEYS = Object.keys(UPGRADES) as Upgrade[];
export const EVOLUTIONS: Record<EvolvingWeapon, { name: string; passive: Passive; detail: string }> = {
  bolt: { name: "Reactor railgun", passive: "reactor", detail: "Fire a heavy beam through every enemy in a long line." },
  blade: { name: "Magnetic grinder", passive: "magnet", detail: "Pull nearby enemies into a wider, stronger ring of cutters." },
  arc: { name: "Storm relay", passive: "boots", detail: "Every lightning impact releases a shockwave into nearby enemies." },
};
export const EVOLUTION_KEYS = Object.keys(EVOLUTIONS) as EvolvingWeapon[];
export const isWeapon = (key: Upgrade): key is Weapon => WEAPONS.includes(key as Weapon);
export const weaponCount = (r: Pick<Run, "upgrades">) => WEAPONS.filter(key => r.upgrades[key] > 0).length;
export const canUpgrade = (r: Pick<Run, "upgrades">, key: Upgrade) => r.upgrades[key] < UPGRADES[key].max
  && (!isWeapon(key) || r.upgrades[key] > 0 || weaponCount(r) < WEAPON_SLOTS);
export const canEvolve = (r: Pick<Run, "upgrades" | "evolutions">, key: EvolvingWeapon) => !r.evolutions[key]
  && r.upgrades[key] === UPGRADES[key].max && r.upgrades[EVOLUTIONS[key].passive] > 0;
export const bladeRadius = (r: Pick<Run, "upgrades" | "evolutions">) => 42 + r.upgrades.blade * 9 + (r.evolutions.blade ? 28 : 0);
const droneCount = (r: Pick<Run, "upgrades" | "rig">) => r.upgrades.drone ? 1 + Math.floor((r.upgrades.drone - 1) / 2) + (r.rig.robot === "engineer" && r.rig.mastery >= 2 ? 1 : 0) : 0;
export const dronePositions = (r: Pick<Run, "player" | "time" | "upgrades" | "rig">) => Array.from({ length: droneCount(r) }, (_, i) => {
  const angle = r.time * 0.9 + i * Math.PI * 2 / droneCount(r);
  return { x: r.player.x + Math.cos(angle) * 54, y: r.player.y + Math.sin(angle) * 54 };
});
export function evolutionHint(key: Upgrade, r: Pick<Run, "upgrades" | "evolutions">): string | undefined {
  if (!EVOLUTION_KEYS.includes(key as EvolvingWeapon)) return;
  const weapon = key as EvolvingWeapon, evo = EVOLUTIONS[weapon];
  if (r.evolutions[weapon]) return `${evo.name} evolved`;
  return canEvolve(r, weapon) ? `${evo.name} ready in an elite chest`
    : `${evo.name}: weapon Lv 5 + ${UPGRADES[evo.passive].name} Lv 1 + elite chest`;
}
export function upgradeGain(key: Upgrade, level: number) {
  switch (key) {
    case "bolt": return level === 2 ? "Triple shot unlocked" : level === 4 ? "5-shot piercing fan" : `Base damage ${level + 1} → ${level + 2}`;
    case "blade": return level ? `${level + 1} → ${level + 2} blades · wider orbit` : "2 blades orbit your robot";
    case "arc": return level ? `${level + 1} → ${level + 2} lightning targets` : "Lightning chains to 2 targets";
    case "mine": return level ? "Stronger blasts · faster mine deployment" : "Drop mines that explode when enemies approach";
    case "drone": return level === 2 || level === 4 ? "An extra drone joins your formation" : level ? "Faster firing · stronger drone bolts" : "An orbiting drone fires at nearby enemies";
    case "reactor": return "+35% base weapon damage · repair 2 HP";
    case "magnet": return "+35 pickup range · repair 2 HP";
    case "boots": return "+22 movement speed · repair 2 HP";
  }
}
