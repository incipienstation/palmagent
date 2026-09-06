import type { RoutinePreset } from "@palmagent/shared";

// Minimal 5-field cron ("m h dom mon dow") — enough for Routines without a
// dependency. Supports *, lists, ranges, steps (*/15, 1-20/2). dow 0|7 = Sunday.
// Standard cron quirk preserved: when BOTH dom and dow are restricted, a time
// matches if EITHER matches (otherwise both fields must match).

// Compile a friendly cadence preset into a 5-field cron. Returns null for the
// presets that have no fixed cron: "manual" (never auto-fires) and "custom" (the
// caller uses the raw cron the user typed). `hour` (0-23) and `dayOfWeek` (0-6,
// Sun-Sat) fill in daily/weekly/weekdays; a missing/non-integer value falls back
// to the default (9 / Monday), and an out-of-range number clamps into range.
export function presetToCron(preset: RoutinePreset, hour = 9, dayOfWeek = 1): string | null {
  const h = clampInt(hour, 0, 23, 9);
  const d = clampInt(dayOfWeek, 0, 6, 1);
  switch (preset) {
    case "hourly":
      return "0 * * * *";
    case "daily":
      return `0 ${h} * * *`;
    case "weekly":
      return `0 ${h} * * ${d}`;
    case "weekdays":
      return `0 ${h} * * 1-5`;
    case "manual":
    case "custom":
      return null;
  }
}

function clampInt(n: unknown, lo: number, hi: number, dflt: number): number {
  const v = typeof n === "number" && Number.isInteger(n) ? n : dflt;
  return Math.min(hi, Math.max(lo, v));
}

interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

const FIELDS: { name: string; min: number; max: number }[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dom", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dow", min: 0, max: 7 },
];

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron must have 5 fields ("m h dom mon dow"), got ${parts.length}`);
  }
  const sets = parts.map((part, i) => parseField(part, FIELDS[i]));
  const dow = sets[4];
  if (dow.delete(7)) dow.add(0); // 7 == Sunday == 0
  return {
    minute: sets[0],
    hour: sets[1],
    dom: sets[2],
    month: sets[3],
    dow,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
}

function parseField(part: string, f: { name: string; min: number; max: number }): Set<number> {
  const out = new Set<number>();
  for (const piece of part.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(piece);
    if (!m) throw new Error(`bad cron ${f.name} field: "${piece}"`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error(`bad cron step in "${piece}"`);
    let lo = f.min;
    let hi = f.max;
    if (m[1] !== "*") {
      const [a, b] = m[1].split("-").map(Number);
      lo = a;
      hi = b ?? (m[2] ? f.max : a); // "5/10" = every 10 starting at 5; bare "5" = exactly 5
    }
    if (lo < f.min || hi > f.max || lo > hi) {
      throw new Error(`cron ${f.name} out of range ${f.min}-${f.max}: "${piece}"`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

function dayMatches(spec: CronSpec, d: Date): boolean {
  if (!spec.month.has(d.getMonth() + 1)) return false;
  const domOk = spec.dom.has(d.getDate());
  const dowOk = spec.dow.has(d.getDay());
  // Classic cron: both restricted → OR; otherwise AND (wildcard always true).
  return spec.domRestricted && spec.dowRestricted ? domOk || dowOk : domOk && dowOk;
}

// Next fire time strictly after `fromMs`, in local time. Scans minute-by-minute
// with whole-day skips; gives up past ~13 months (an unsatisfiable spec).
export function nextRun(expr: string | CronSpec, fromMs: number): number | undefined {
  const spec = typeof expr === "string" ? parseCron(expr) : expr;
  const d = new Date(fromMs);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = fromMs + 400 * 24 * 60 * 60 * 1000;
  while (d.getTime() < limit) {
    if (!dayMatches(spec, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!spec.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!spec.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d.getTime();
  }
  return undefined;
}
