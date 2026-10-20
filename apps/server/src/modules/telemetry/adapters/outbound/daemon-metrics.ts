import { z } from "zod";
import { TELEMETRY, TELEMETRY_METRICS, type TelemetryMetric, type TelemetryPoint } from "@palmagent/shared/telemetry";
import { daemonRequest } from "../../../../platform/process/daemon-client.js";
import { readTelemetryChoice } from "./preference.js";
import type { TelemetryProducer } from "./producer.js";

const integer = z.number().int().nonnegative().max(100000);
const Point = z.object({
  name: z.string().refine(name => Object.hasOwn(TELEMETRY_METRICS, name)),
  attributes: z.object({
    concurrency: z.string().refine(value => TELEMETRY.concurrency.includes(value)),
    operation: z.string().refine(value => TELEMETRY.operations.includes(value)).optional(),
    outcome: z.string().refine(value => TELEMETRY.outcomes.includes(value)).optional(),
  }).strict(),
  count: integer.positive(), sum: z.number().finite().nonnegative(), buckets: z.array(integer).max(20),
}).strict().refine(point => {
  const metric = TELEMETRY_METRICS[point.name as TelemetryMetric];
  if (!metric) return false;
  const operation = point.name === "palmagent.operation.duration";
  return point.buckets.length === metric.bounds.length + 1 &&
    point.buckets.reduce((a, b) => a + b, 0) === point.count && point.sum <= point.count * metric.max &&
    (operation ? !!point.attributes.operation && !!point.attributes.outcome : !point.attributes.operation && !point.attributes.outcome);
});
const Snapshot = z.object({
  schemaVersion: z.literal(1), revision: z.string().uuid(), epoch: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative(), sampledAt: z.number().int().nonnegative(), points: z.array(Point).max(32),
}).strict();
const Status = z.object({
  version: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-alpha\.\d{1,6})?$/),
  instance: z.string().min(1).max(128), telemetry: Snapshot,
});
type SnapshotValue = z.infer<typeof Snapshot>;
const key = (point: TelemetryPoint) => JSON.stringify([point.name, point.attributes.concurrency, point.attributes.operation, point.attributes.outcome]);

/** A new web reader establishes a baseline; retained daemon counters must never be replayed. */
export class DaemonMetricReader {
  private previous?: { instance: string; snapshot: SnapshotValue };
  reset(): void { this.previous = undefined; }
  read(input: unknown, revision: string, now = Date.now()) {
    const parsed = Status.safeParse(input);
    if (!parsed.success || parsed.data.telemetry.revision !== revision) { this.reset(); return; }
    const { telemetry: snapshot, instance, version } = parsed.data;
    if (snapshot.sampledAt > now + 2000 || snapshot.sampledAt < now - 30_000 ||
        snapshot.startedAt > snapshot.sampledAt || snapshot.sampledAt - snapshot.startedAt > 610_000) { this.reset(); return; }
    const previous = this.previous;
    this.previous = { instance, snapshot };
    if (!previous || previous.instance !== instance || previous.snapshot.revision !== revision) return;
    const sameEpoch = snapshot.epoch === previous.snapshot.epoch;
    if (snapshot.sampledAt <= previous.snapshot.sampledAt) return;
    const prior = new Map(sameEpoch ? previous.snapshot.points.map(p => [key(p), p]) : []);
    const points: TelemetryPoint[] = [];
    for (const current of snapshot.points) {
      const old = prior.get(key(current));
      const point = { ...current, count: current.count - (old?.count ?? 0), sum: current.sum - (old?.sum ?? 0),
        buckets: current.buckets.map((n, i) => n - (old?.buckets[i] ?? 0)) };
      if (point.count > 0 && point.sum >= 0 && point.buckets.every(n => n >= 0)) points.push(point);
    }
    return { version, points, start: sameEpoch ? previous.snapshot.sampledAt : snapshot.startedAt, end: snapshot.sampledAt };
  }
}
export function collectDaemonMetrics(dataDir: string, preferencePath: string, producer: TelemetryProducer) {
  const reader = new DaemonMetricReader();
  let busy = false, closed = false;
  const poll = async () => {
    if (busy || closed) return;
    producer.refresh();
    const choice = readTelemetryChoice(preferencePath);
    if (!producer.active || !choice?.enabled) { reader.reset(); return; }
    busy = true;
    try {
      const status = await daemonRequest(dataDir, { action: "status" }, 5000);
      producer.refresh();
      if (closed || !producer.active || readTelemetryChoice(preferencePath)?.revision !== choice.revision) { reader.reset(); return; }
      const batch = reader.read(status, choice.revision);
      if (batch) producer.enqueue({ service: "palmagent.daemon", version: batch.version, implementation: "rust",
        os: "linux", arch: process.arch === "arm64" ? "arm64" : "amd64", source: "production" }, batch.points, batch.start, batch.end);
    } catch { reader.reset(); } // Older/unavailable daemons provide no native metrics; never relabel Node data.
    finally { busy = false; }
  };
  const timer = setInterval(() => { void poll(); }, 15_000); timer.unref();
  return () => { closed = true; clearInterval(timer); reader.reset(); };
}
