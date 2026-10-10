import { baseRig, masteryRank, relaysRestored, ROBOTS, ROBOT_KEYS, SECTORS, SECTOR_KEYS, WORKSHOP_CAP, WORKSHOP_KEYS, workshopCost } from "./campaign-catalog";
import type { Robot, Run, Sector, Weapon, Workshop } from "./model";
import { restore, serialize } from "./save";
import { freshRun } from "./simulation";

export type Profile = {
  parts: number; earned: number; unlockedSector: Sector; clears: number;
  mastery: Record<Robot, number>; workshop: Record<Workshop, number>;
  robot: Robot; sector: Sector; starters: Record<Robot, Weapon>;
};
export type Debrief = { outcome: "victory" | "defeat" | "retreat"; parts: number; mastery: number; unlocks: string[] };
export type Campaign = { run: Run; profile: Profile; settled: boolean; hangar: boolean; report: Debrief | null };
const LIMIT = 1_000_000;
const capped = (value: number) => Math.min(LIMIT, value);
export function freshProfile(): Profile {
  return { parts: 0, earned: 0, unlockedSector: 1, clears: 0, mastery: { scout: 0, bulwark: 0, engineer: 0 },
    workshop: { hull: 0, power: 0, salvage: 0 }, robot: "scout", sector: 1,
    starters: { scout: "bolt", bulwark: "blade", engineer: "drone" } };
}
export const robotUnlocked = (p: Profile, robot: Robot) => p.earned >= ROBOTS[robot].unlock;
export const starterOptions = (p: Profile, robot: Robot): Weapon[] => masteryRank(p.mastery[robot]) >= 1
  ? [ROBOTS[robot].weapon, ROBOTS[robot].alternate] : [ROBOTS[robot].weapon];
export function selectRobot(p: Profile, robot: Robot): boolean {
  if (!ROBOT_KEYS.includes(robot) || !robotUnlocked(p, robot)) return false;
  p.robot = robot; return true;
}
export function selectSector(p: Profile, sector: Sector): boolean {
  if (!SECTOR_KEYS.includes(sector) || sector > p.unlockedSector) return false;
  p.sector = sector; return true;
}
export function selectStarter(p: Profile, weapon: Weapon): boolean {
  if (!starterOptions(p, p.robot).includes(weapon)) return false;
  p.starters[p.robot] = weapon; return true;
}
export function buyUpgrade(p: Profile, key: Workshop): boolean {
  if (!WORKSHOP_KEYS.includes(key)) return false;
  const level = p.workshop[key], cost = workshopCost(level);
  if (level >= WORKSHOP_CAP || p.parts < cost) return false;
  p.parts -= cost; p.workshop[key]++; return true;
}
export function expeditionReward(r: Run, victory = r.won) {
  const salvage = Math.floor(r.kills / 5) + r.elitesCleared * 6 + relaysRestored(r) * 10;
  return {
    parts: capped(Math.floor((salvage * (victory ? 1 : 0.5) + (victory ? 25 * r.rig.sector : 0)) * (1 + r.rig.workshop.salvage * 0.1))),
    mastery: capped(Math.floor(r.kills / 10) + r.elitesCleared * 4 + relaysRestored(r) * 6 + (victory ? 20 : 0)),
  };
}
/** Settlement and the finished run are persisted together; replaying a result cannot award it twice. */
export function settleExpedition(c: Campaign, retreat = false): boolean {
  const r = c.run, p = c.profile;
  if (c.settled || (!retreat && !r.won && r.hull > 0)) return false;
  const before = ROBOT_KEYS.filter(robot => robotUnlocked(p, robot));
  const rank = masteryRank(p.mastery[r.rig.robot]), reward = expeditionReward(r);
  const unlocks: string[] = [];
  p.parts = capped(p.parts + reward.parts); p.earned = capped(p.earned + reward.parts);
  p.mastery[r.rig.robot] = capped(p.mastery[r.rig.robot] + reward.mastery);
  if (r.won) {
    p.clears = capped(p.clears + 1);
    if (r.rig.sector < 3 && p.unlockedSector <= r.rig.sector) {
      p.unlockedSector = (r.rig.sector + 1) as Sector;
      if (p.sector === r.rig.sector) p.sector = p.unlockedSector;
      unlocks.push(`Sector ${p.unlockedSector}: ${SECTORS[p.unlockedSector].name}`);
    }
  }
  for (const robot of ROBOT_KEYS) if (!before.includes(robot) && robotUnlocked(p, robot)) unlocks.push(`${ROBOTS[robot].name} unlocked`);
  const nextRank = masteryRank(p.mastery[r.rig.robot]);
  if (rank < 1 && nextRank >= 1) unlocks.push(`${ROBOTS[r.rig.robot].name}: alternate starting weapon`);
  if (rank < 2 && nextRank >= 2) unlocks.push(`${ROBOTS[r.rig.robot].name}: ${ROBOTS[r.rig.robot].mastery}`);
  c.report = { outcome: r.won ? "victory" : retreat ? "retreat" : "defeat", ...reward, unlocks };
  if (retreat && !r.won) r.hull = 0;
  c.settled = true; return true;
}
export function launchExpedition(c: Campaign, seed?: number): boolean {
  if (!c.hangar || !c.settled || !ROBOT_KEYS.includes(c.profile.robot) || !SECTOR_KEYS.includes(c.profile.sector)
    || !robotUnlocked(c.profile, c.profile.robot) || c.profile.sector > c.profile.unlockedSector
    || !starterOptions(c.profile, c.profile.robot).includes(c.profile.starters[c.profile.robot])) return false;
  const p = c.profile;
  c.run = freshRun(seed, { ...baseRig(), robot: p.robot, sector: p.sector, mastery: masteryRank(p.mastery[p.robot]), workshop: { ...p.workshop } }, p.starters[p.robot]);
  c.settled = false; c.report = null; c.hangar = false; return true;
}
export function serializeCampaign(c: Campaign): string {
  // A single write also retains the historic run-shaped format for in-place migration.
  return JSON.stringify({ ...JSON.parse(serialize(c.run)), campaign: { version: 1, profile: c.profile, settled: c.settled, hangar: c.hangar, report: c.report } });
}
const integer = (v: unknown, min = 0, max = LIMIT): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
function validProfile(p: Profile): boolean {
  return Boolean(p && integer(p.parts) && integer(p.earned) && p.parts <= p.earned && integer(p.clears)
    && SECTOR_KEYS.includes(p.unlockedSector) && SECTOR_KEYS.includes(p.sector) && p.sector <= p.unlockedSector
    && ROBOT_KEYS.includes(p.robot) && robotUnlocked(p, p.robot)
    && p.mastery && ROBOT_KEYS.every(robot => integer(p.mastery[robot]))
    && p.workshop && WORKSHOP_KEYS.every(key => integer(p.workshop[key], 0, WORKSHOP_CAP))
    && p.starters && ROBOT_KEYS.every(robot => starterOptions(p, robot).includes(p.starters[robot])));
}
function validReport(r: Debrief | null): boolean {
  return r === null || Boolean(r && ["victory", "defeat", "retreat"].includes(r.outcome) && integer(r.parts) && integer(r.mastery)
    && Array.isArray(r.unlocks) && r.unlocks.length <= 6 && r.unlocks.every(s => typeof s === "string" && s.length <= 200));
}
export function restoreCampaign(raw: string | null): Campaign {
  const fresh = (): Campaign => ({ run: freshRun(), profile: freshProfile(), settled: false, hangar: false, report: null });
  if (!raw) return fresh();
  try {
    if (raw.length > 180_000) return fresh();
    const parsed = JSON.parse(raw), run = restore(raw);
    if (!parsed?.campaign) return { ...fresh(), run };
    const saved = parsed.campaign;
    if (saved.version !== 1 || !validProfile(saved.profile) || typeof saved.settled !== "boolean" || typeof saved.hangar !== "boolean"
      || !validReport(saved.report) || saved.settled !== (saved.report !== null)
      || (saved.settled && (!run.won && run.hull > 0 || (saved.report.outcome === "victory") !== run.won))) return fresh();
    return { run, profile: saved.profile, settled: saved.settled, hangar: saved.hangar, report: saved.report };
  } catch { return fresh(); }
}
