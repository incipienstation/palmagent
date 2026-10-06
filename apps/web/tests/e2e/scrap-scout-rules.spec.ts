import { expect, test } from "@playwright/test";
import { cleared, enemies, fire, freshRun, restoreRun, takeUpgrade, won, type Upgrade } from "../../src/games/scrap-scout/engine";

test("a barrel creates a chain clear, the shot is deterministic, and empty rooms cannot fire again", () => {
  const start = freshRun(1), shot = fire(start, 0);
  expect(cleared(shot.run)).toBe(true);
  expect(shot.kills).toBe(3);
  expect(shot.frames.some(f => f.impacts.some(e => e.kind === "blast"))).toBe(true);
  expect(shot.run.hull).toBe(7);
  expect(fire(start, 0)).toEqual(shot);
  expect(start.total).toBe(0);
  expect(fire(shot.run, 0).frames).toEqual([]);
  expect(takeUpgrade(start, "split")).toBe(start);
});

test("both layouts and different builds can beat all four rooms; upgrades change actual shot behavior", () => {
  for (const seed of [1, 2]) for (const upgrade of ["power", "split", "arc"] as Upgrade[]) {
    let run = freshRun(seed);
    for (let shot = 0; shot < 40 && !won(run) && run.hull > 0; shot++) {
      if (cleared(run)) { run = takeUpgrade(run, upgrade); continue; }
      const outcomes = Array.from({ length: 49 }, (_, i) => fire(run, -72 + i * 3));
      outcomes.sort((a, b) => a.run.targets.reduce((s, t) => s + (t.kind === "barrel" ? 0 : t.hp), 0) - b.run.targets.reduce((s, t) => s + (t.kind === "barrel" ? 0 : t.hp), 0));
      run = outcomes[0].run;
    }
    expect(won(run), `${seed} / ${upgrade} must be winnable`).toBe(true);
  }
  const clear = fire(freshRun(1), 0).run;
  const damaged = { ...clear, hull: 3 };
  const power = takeUpgrade(damaged, "power"), repair = takeUpgrade(damaged, "repair");
  expect(power.hull).toBe(4);
  expect(repair.hull).toBe(6);
  expect(fire(power, -18).frames.flatMap(f => f.impacts)[0].damage).toBe(3);
  expect(fire(repair, -18).frames.flatMap(f => f.impacts)[0].damage).toBe(2);
  const split = fire(takeUpgrade(clear, "split"), 0);
  expect(split.frames[0].balls).toHaveLength(2);
  const arcRun = takeUpgrade(clear, "arc");
  expect(Array.from({ length: 25 }, (_, i) => fire(arcRun, -72 + i * 6)).some(s => s.frames.some(f => f.impacts.some(e => e.kind === "arc")))).toBe(true);
});

test("retaliation, saved damage, and invalid saves preserve bounded run state", () => {
  const second = takeUpgrade(fire(freshRun(1), 0).run, "power");
  const one = fire(second, 72).run, two = fire(one, 72).run;
  expect(one.hull).toBe(7);
  if (enemies(two).length) expect(two.hull).toBe(6);
  expect(restoreRun(JSON.stringify(two))).toEqual(two);
  for (const value of [null, "null", "broken", JSON.stringify({ ...two, upgrades: ["bad"] }), JSON.stringify({ ...two, room: 40 }), JSON.stringify({ ...two, targets: [] })]) {
    expect(restoreRun(value).room).toBe(0);
  }
  expect(fire({ ...second, hull: 0 }, 0).frames).toEqual([]);
});
