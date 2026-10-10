import { canEvolve, canUpgrade, EVOLUTION_KEYS, UPGRADE_KEYS, UPGRADES } from "./catalog";
import type { Reward, Run, Upgrade } from "./model";
import { maxHull, repairBonus } from "./campaign-catalog";

function improve(r: Run, key: Upgrade) {
  r.upgrades[key]++;
  r.hull = Math.min(maxHull(r), r.hull + (UPGRADES[key].max === 3 ? 2 : 1) + repairBonus(r));
  r.invulnerable = 1;
}
export function chooseUpgrade(r: Run, choice: Upgrade): boolean {
  if (!r.choices.includes(choice) || r.hull <= 0 || r.won || r.rewards.length || !canUpgrade(r, choice)) return false;
  improve(r, choice); r.choices = []; return true;
}
export function offerUpgrades(r: Run, random: () => number) {
  const available = UPGRADE_KEYS.filter(key => canUpgrade(r, key));
  for (let i = available.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1)); [available[i], available[j]] = [available[j], available[i]];
  }
  r.choices = available.slice(0, 3);
  if (!r.choices.length) r.hull = Math.min(maxHull(r), r.hull + 2);
}
export function openChest(r: Run, id: number): boolean {
  const chest = r.chests.find(c => c.id === id);
  if (!chest || r.hull <= 0 || r.won || r.choices.length || r.rewards.length || Math.hypot(chest.x - r.player.x, chest.y - r.player.y) > 32) return false;
  const rewards: Reward[] = EVOLUTION_KEYS.filter(key => canEvolve(r, key)).map(weapon => ({ kind: "evolve", weapon }));
  for (const key of UPGRADE_KEYS) {
    if (rewards.length >= 3) break;
    if (r.upgrades[key] > 0 && canUpgrade(r, key)) rewards.push({ kind: "upgrade", upgrade: key });
  }
  if (rewards.length < 3) rewards.push({ kind: "repair" });
  r.rewards = rewards; r.chests = r.chests.filter(c => c.id !== id); return true;
}
export function chooseReward(r: Run, index: number): boolean {
  if (!Number.isInteger(index) || r.hull <= 0 || r.won || r.choices.length) return false;
  const reward = r.rewards[index];
  if (!reward) return false;
  if (reward.kind === "evolve") {
    if (!canEvolve(r, reward.weapon)) return false;
    r.evolutions[reward.weapon] = true; r.hull = Math.min(maxHull(r), r.hull + 2);
  } else if (reward.kind === "upgrade") {
    if (!canUpgrade(r, reward.upgrade)) return false;
    improve(r, reward.upgrade);
  } else r.hull = maxHull(r);
  r.invulnerable = 1.5; r.rewards = []; return true;
}
