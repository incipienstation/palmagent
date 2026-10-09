/** Host integration surface; the game knows nothing about conversations or agent tasks. */
export { SurvivorGame } from "./SurvivorGame";
export { RobotArt } from "./art";
export { SAVE_KEY, LEGACY_SAVE_KEY } from "./rules/save";
export type { RunStorage } from "./useGameSession";
export async function preloadGame() { await (await import("./scene")).preloadSprites(); }
