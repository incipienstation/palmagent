/** A shot is deterministic. Phaser plays its trace; elapsed browser time never changes a run. */
export const W = 360, H = 440, ORIGIN = { x: 180, y: 405 };
export const SAVE_KEY = "game:scrap-scout:v1";
export type Kind = "drone" | "turret" | "barrel" | "boss";
export type Target = { id: number; kind: Kind; x: number; y: number; hp: number; max: number; radius: number };
export type Upgrade = "power" | "split" | "arc" | "repair";
export const UPGRADES: Record<Upgrade, { name: string; detail: string }> = {
  power: { name: "Heavy core", detail: "+2 damage on every impact." },
  split: { name: "Split shot", detail: "Launch one more orb in a fan." },
  arc: { name: "Chain lightning", detail: "Hits arc to another nearby enemy." },
  repair: { name: "Field repair", detail: "Restore 3 hull and gain +1 impact damage." },
};
export const ROOM_NAMES = ["The scrapyard", "Crossfire", "Reactor vault", "The Warden"];
export type Run = { version: 1; seed: number; room: number; hull: number; shots: number; total: number; upgrades: Upgrade[]; targets: Target[] };
export type Point = { x: number; y: number };
export type Impact = Point & { kind: "hit" | "blast" | "arc"; target: number; hp: number; damage: number; from?: Point };
export type Frame = { balls: Point[]; impacts: Impact[] };
export const enemies = (run: Run) => run.targets.filter(t => t.kind !== "barrel" && t.hp > 0);
export const cleared = (run: Run) => enemies(run).length === 0;
export const won = (run: Run) => cleared(run) && run.room === 3;
export function roomTargets(room: number, seed: number): Target[] {
  const layouts: [Kind, number, number, number][][] = [
    [["drone", 110, 155, 2], ["drone", 250, 155, 2], ["drone", 180, 105, 2], ["barrel", 180, 205, 1]],
    [["turret", 85, 105, 5], ["turret", 275, 105, 5], ["drone", 125, 240, 3], ["drone", 235, 240, 3], ["barrel", 75, 195, 1], ["barrel", 285, 195, 1]],
    [["turret", 180, 90, 7], ["drone", 65, 160, 4], ["drone", 295, 160, 4], ["turret", 110, 270, 5], ["barrel", 250, 255, 1], ["barrel", 260, 165, 1]],
    [["boss", 180, 130, 22], ["drone", 75, 250, 4], ["drone", 285, 230, 4], ["barrel", 105, 160, 1], ["barrel", 265, 120, 1]],
  ];
  return layouts[room].map(([kind, x, y, hp], id) => ({ id, kind, x: seed % 2 ? x : W - x, y, hp, max: hp, radius: kind === "boss" ? 37 : kind === "barrel" ? 20 : 23 }));
}
export function freshRun(seed = Math.floor(Math.random() * 1_000_000) + 1): Run {
  return { version: 1, seed, room: 0, hull: 7, shots: 0, total: 0, upgrades: [], targets: roomTargets(0, seed) };
}
export const clampAim = (angle: number) => Math.max(-72, Math.min(72, Number.isFinite(angle) ? angle : 0));
export function takeUpgrade(run: Run, upgrade: Upgrade): Run {
  if (!cleared(run) || won(run) || run.hull <= 0 || !Object.hasOwn(UPGRADES, upgrade)) return run;
  return { ...run, room: run.room + 1, shots: 0, hull: Math.min(7, run.hull + (upgrade === "repair" ? 3 : 1)),
    upgrades: [...run.upgrades, upgrade], targets: roomTargets(run.room + 1, run.seed) };
}
export function fire(run: Run, aim: number): { run: Run; frames: Frame[]; hits: number; kills: number } {
  if (run.hull <= 0 || cleared(run)) return { run, frames: [], hits: 0, kills: 0 };
  const next: Run = { ...run, targets: run.targets.map(t => ({ ...t })), shots: run.shots + 1, total: run.total + 1 };
  const count = 1 + run.upgrades.filter(u => u === "split").length;
  const damage = 1 + run.upgrades.reduce((total, u) => total + (u === "power" ? 2 : u === "repair" ? 1 : 0), 0);
  const arc = run.upgrades.filter(u => u === "arc").length;
  const balls = Array.from({ length: count }, (_, i) => {
    const a = (clampAim(aim) + (i - (count - 1) / 2) * 12) * Math.PI / 180;
    return { ...ORIGIN, vx: Math.sin(a) * 8, vy: -Math.cos(a) * 8, cooldown: new Map<number, number>() };
  });
  const frames: Frame[] = [];
  let hits = 0;
  for (let step = 0; step < 155; step++) {
    const impacts: Impact[] = [];
    const hit = (t: Target, amount: number, kind: Impact["kind"], from?: Point) => {
      if (t.hp <= 0) return;
      const dealt = Math.min(t.hp, amount); t.hp -= dealt; hits++;
      impacts.push({ x: t.x, y: t.y, target: t.id, kind, hp: t.hp, damage: dealt, from });
      if (t.hp === 0 && t.kind === "barrel") {
        impacts.push({ x: t.x, y: t.y, target: t.id, kind: "blast", hp: 0, damage: 0 });
        for (const other of next.targets) if (other.hp > 0 && Math.hypot(other.x - t.x, other.y - t.y) <= 108) hit(other, 4, "hit");
      }
    };
    for (const ball of balls) {
      ball.x += ball.vx; ball.y += ball.vy;
      if (ball.x < 15 || ball.x > W - 15) { ball.x = Math.max(15, Math.min(W - 15, ball.x)); ball.vx *= -1; }
      if (ball.y < 20 || ball.y > H - 16) { ball.y = Math.max(20, Math.min(H - 16, ball.y)); ball.vy *= -1; }
      for (const t of next.targets) {
        if (t.hp <= 0 || (ball.cooldown.get(t.id) ?? -1) > step) continue;
        const dx = ball.x - t.x, dy = ball.y - t.y, distance = Math.hypot(dx, dy);
        if (distance > t.radius + 5) continue;
        ball.cooldown.set(t.id, step + 8);
        hit(t, damage, "hit");
        if (arc && t.kind !== "barrel") {
          const nearby = next.targets.filter(o => o.id !== t.id && o.hp > 0 && Math.hypot(o.x - t.x, o.y - t.y) < 150)
            .sort((a, b) => Math.hypot(a.x - t.x, a.y - t.y) - Math.hypot(b.x - t.x, b.y - t.y))[0];
          if (nearby) hit(nearby, arc, "arc", { x: t.x, y: t.y });
        }
        // Destroyed targets allow the shot through; surviving armor reflects it.
        if (t.hp > 0) {
          const nx = dx / (distance || 1), ny = dy / (distance || 1), dot = ball.vx * nx + ball.vy * ny;
          ball.vx -= 2 * dot * nx; ball.vy -= 2 * dot * ny;
          ball.x = t.x + nx * (t.radius + 6); ball.y = t.y + ny * (t.radius + 6);
        }
      }
    }
    frames.push({ balls: balls.map(({ x, y }) => ({ x, y })), impacts });
    if (cleared(next)) break;
  }
  // Surviving enemies retaliate together every second shot, never on a clock.
  if (!cleared(next) && next.shots % 2 === 0) next.hull = Math.max(0, next.hull - (next.room === 3 ? 2 : 1));
  return { run: next, frames, hits, kills: enemies(run).length - enemies(next).length };
}
export function restoreRun(raw: string | null): Run {
  try {
    if (!raw || raw.length > 10_000) return freshRun();
    const s = JSON.parse(raw) as Run;
    if (s.version !== 1 || !Number.isInteger(s.seed) || s.seed < 1 || s.seed > 1_000_000 || !Number.isInteger(s.room) || s.room < 0 || s.room > 3
      || !Number.isInteger(s.hull) || s.hull < 0 || s.hull > 7 || !Number.isInteger(s.shots) || s.shots < 0 || s.shots > 1000
      || !Number.isInteger(s.total) || s.total < s.shots || s.total > 4000 || !Array.isArray(s.upgrades) || s.upgrades.length !== s.room
      || s.upgrades.some(u => !Object.hasOwn(UPGRADES, u)) || !Array.isArray(s.targets)) return freshRun();
    const targets = roomTargets(s.room, s.seed);
    if (s.targets.length !== targets.length || targets.some((t, i) => s.targets[i]?.id !== t.id || !Number.isInteger(s.targets[i]?.hp) || s.targets[i].hp < 0 || s.targets[i].hp > t.max)) return freshRun();
    return { version: 1, seed: s.seed, room: s.room, hull: s.hull, shots: s.shots, total: s.total, upgrades: s.upgrades,
      targets: targets.map((t, i) => ({ ...t, hp: s.targets[i].hp })) };
  } catch { return freshRun(); }
}
