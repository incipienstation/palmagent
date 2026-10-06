/** Echo Garden advances only on a deliberate move, never on elapsed time. */
export type Phase = 0 | 1 | 2;
export type Link = readonly [from: number, to: number, delay: 1 | 2];
export type Level = {
  title: string;
  lesson: string;
  initial: readonly Phase[];
  links: readonly Link[];
};
export type Echo = { plant: number; turns: 1 | 2 };
export type Garden = { plants: Phase[]; echoes: Echo[] };
/** -1 lets existing echoes arrive without growing a plant. */
export type Move = number;
export const PHASE_NAMES = ["Seed", "Bud", "Bloom"] as const;
export const plantName = (index: number) => String.fromCharCode(65 + index);
export const startGarden = (level: Level): Garden => ({ plants: [...level.initial], echoes: [] });
export const isSolved = (garden: Garden) => garden.plants.every(phase => phase === 2) && garden.echoes.length === 0;
const grow = (phase: Phase): Phase => ((phase + 1) % 3) as Phase;

export function playMove(level: Level, garden: Garden, move: Move): Garden {
  if (isSolved(garden) || !Number.isInteger(move) || move < -1 || move >= garden.plants.length
    || (move === -1 && garden.echoes.length === 0)) return garden;
  const plants = [...garden.plants];
  const echoes: Echo[] = [];
  // The chosen plant grows first. Only tapping into bloom sends new echoes.
  // Arriving echoes never send further echoes, so every wait is finite.
  if (move !== -1) {
    plants[move] = grow(plants[move]);
    if (plants[move] === 2) for (const [from, to, delay] of level.links) {
      if (from === move) echoes.push({ plant: to, turns: delay });
    }
  }
  // Resolve only echoes that existed before this move. New echoes always wait.
  for (const echo of garden.echoes) {
    if (echo.turns === 1) plants[echo.plant] = grow(plants[echo.plant]);
    else echoes.push({ ...echo, turns: 1 });
  }
  return { plants, echoes };
}

export function replay(level: Level, moves: readonly Move[]): Garden {
  return moves.reduce((garden, move) => playMove(level, garden, move), startGarden(level));
}
