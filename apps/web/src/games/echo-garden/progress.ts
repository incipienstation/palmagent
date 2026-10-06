import { isSolved, playMove, replay } from "./engine";
import { LEVELS } from "./levels";

export const PROGRESS_KEY = "game:echo-garden:v1";
export type Progress = { version: 1; level: number; unlocked: number; moves: number[][] };
export const freshProgress = (): Progress => ({ version: 1, level: 0, unlocked: 1, moves: LEVELS.map(() => []) });

/** Persist moves, not trusted board snapshots; rules reconstruct pending echoes. */
export function restoreProgress(raw: string | null): Progress {
  if (!raw || raw.length > 250_000) return freshProgress();
  try {
    const saved = JSON.parse(raw) as Progress;
    if (saved.version !== 1 || !Number.isInteger(saved.unlocked) || saved.unlocked < 1 || saved.unlocked > LEVELS.length
      || !Number.isInteger(saved.level) || saved.level < 0 || saved.level >= saved.unlocked
      || !Array.isArray(saved.moves) || saved.moves.length !== LEVELS.length
      || !saved.moves.every((moves, i) => Array.isArray(moves) && moves.every(move =>
        Number.isInteger(move) && move >= -1 && move < LEVELS[i].initial.length))) return freshProgress();
    return saved;
  } catch {
    return freshProgress();
  }
}

export type GameAction = { type: "move"; move: number } | { type: "undo" } | { type: "restart" } | { type: "level"; level: number };
export function advanceProgress(progress: Progress, action: GameAction): Progress {
  if (action.type === "level") {
    return Number.isInteger(action.level) && action.level >= 0 && action.level < progress.unlocked
      ? { ...progress, level: action.level } : progress;
  }
  const current = progress.moves[progress.level];
  let moves: number[];
  let unlocked = progress.unlocked;
  if (action.type === "move") {
    const level = LEVELS[progress.level];
    const garden = replay(level, current);
    const next = playMove(level, garden, action.move);
    if (next === garden) return progress;
    moves = [...current, action.move];
    if (isSolved(next)) unlocked = Math.max(unlocked, Math.min(progress.level + 2, LEVELS.length));
  } else if (action.type === "undo") moves = current.slice(0, -1);
  else moves = [];
  return { ...progress, unlocked, moves: progress.moves.map((saved, index) => index === progress.level ? moves : saved) };
}
