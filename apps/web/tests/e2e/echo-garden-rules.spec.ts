import { expect, test } from "@playwright/test";
import { isSolved, playMove, replay, startGarden, type Garden, type Level } from "../../src/games/echo-garden/engine";
import { LEVELS } from "../../src/games/echo-garden/levels";
import { advanceProgress, freshProgress, restoreProgress } from "../../src/games/echo-garden/progress";

test("Echo Garden resolves delayed growth after the tap, without cascading arrivals", () => {
  const level: Level = { title: "Rules", lesson: "", initial: [1, 1, 0], links: [[0, 1, 1], [1, 2, 1]] };
  const first = playMove(level, startGarden(level), 0);
  expect(first).toEqual({ plants: [2, 1, 0], echoes: [{ plant: 1, turns: 1 }] });
  // Waiting blooms B, but an echo-grown bloom does not send a new echo to C.
  expect(playMove(level, first, -1)).toEqual({ plants: [2, 2, 0], echoes: [] });
  // Tapping B instead sends its own echo before the arriving echo cycles B.
  expect(playMove(level, first, 1)).toEqual({ plants: [2, 0, 0], echoes: [{ plant: 2, turns: 1 }] });
  const delayed: Level = { ...level, initial: [1, 2, 2], links: [[0, 1, 2]] };
  const inFlight = playMove(delayed, startGarden(delayed), 0);
  expect(isSolved(inFlight)).toBe(false); // All plants bloom, but an echo is pending.
  expect(playMove(delayed, inFlight, -1)).toEqual({ plants: [2, 2, 2], echoes: [{ plant: 1, turns: 1 }] });
  expect(replay(delayed, [0, -1, -1])).toEqual({ plants: [2, 0, 2], echoes: [] });
  expect(playMove(level, { plants: [0, 0, 0], echoes: [{ plant: 2, turns: 1 }, { plant: 2, turns: 1 }] }, -1))
    .toEqual({ plants: [0, 0, 2], echoes: [] });
});

test("every authored garden is solvable and shortest solutions grow through the progression", () => {
  const minimumTurns: number[] = [];
  for (const level of LEVELS) {
    const key = (garden: Garden) => JSON.stringify([garden.plants, garden.echoes.map(e => [e.plant, e.turns]).sort()]);
    const start = startGarden(level);
    const seen = new Set([key(start)]);
    const queue = [{ garden: start, turns: 0 }];
    let found: number | undefined;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const { garden, turns } = queue[cursor];
      if (isSolved(garden)) { found = turns; break; }
      for (let move = -1; move < level.initial.length; move++) {
        const next = playMove(level, garden, move), nextKey = key(next);
        if (seen.has(nextKey)) continue;
        seen.add(nextKey);
        queue.push({ garden: next, turns: turns + 1 });
      }
      expect(queue.length).toBeLessThan(20_000);
    }
    expect(found, `${level.title} must be solvable`).toBeDefined();
    minimumTurns.push(found!);
  }
  expect(minimumTurns).toEqual([1, 2, 4, 5, 5, 6, 7, 7, 7, 8, 8, 8]);
});

test("Echo Garden saves pending turns, preserves unlocks through undo, and rejects corrupt saves", () => {
  let progress = freshProgress();
  expect(advanceProgress(progress, { type: "level", level: 11 })).toBe(progress);
  progress = advanceProgress(progress, { type: "move", move: 0 });
  expect(progress.unlocked).toBe(2);
  progress = advanceProgress(progress, { type: "level", level: 1 });
  progress = advanceProgress(progress, { type: "move", move: 0 });
  const restored = restoreProgress(JSON.stringify(progress));
  expect(replay(LEVELS[1], restored.moves[1])).toEqual({ plants: [2, 1, 2], echoes: [{ plant: 1, turns: 1 }] });
  progress = advanceProgress(restored, { type: "move", move: -1 });
  expect(progress.unlocked).toBe(3);
  progress = advanceProgress(progress, { type: "undo" });
  expect(progress.moves[1]).toEqual([0]);
  expect(progress.unlocked).toBe(3);
  progress = advanceProgress(progress, { type: "level", level: 0 });
  expect(isSolved(replay(LEVELS[0], progress.moves[0]))).toBe(true);
  progress = advanceProgress(progress, { type: "restart" });
  expect(progress.moves[0]).toEqual([]);
  expect(progress.moves[1]).toEqual([0]);
  for (const raw of ["null", "{}", "broken", JSON.stringify({ ...progress, level: -1 }), JSON.stringify({ ...progress, moves: [[100]] })]) {
    expect(restoreProgress(raw)).toEqual(freshProgress());
  }
});
