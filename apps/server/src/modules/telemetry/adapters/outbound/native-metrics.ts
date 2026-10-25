import { z } from "zod";
import { TELEMETRY, TELEMETRY_METRICS, type TelemetryMetric, type TelemetryPoint } from "@palmagent/shared/telemetry";
import { applicationRequest } from "../../../../platform/ipc/application-runtime.js";
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
  startedAt: z.number().int().nonnegative(), sampledAt: z.number().int().nonnegative(), points: z.array(Point).max(128),
}).strict();
const Status = z.object({
  version: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-alpha\.\d{1,6})?$/),
  instance: z.string().min(1).max(128), telemetry: Snapshot,
});
type SnapshotValue = z.infer<typeof Snapshot>;
const key = (point: TelemetryPoint) => JSON.stringify([point.name, point.attributes.concurrency, point.attributes.operation, point.attributes.outcome]);

/** A new web reader establishes a baseline; retained native counters must never be replayed. */
export class NativeMetricReader {
  private previous?: { instance: string; snapshot: SnapshotValue };
  reset(): void { this.previous = undefined; }
  read(input: unknown, revision: string, now = Date.now()) {
    const parsed = Status.safeParse(input);
    if (!parsed.success || parsed.data.telemetry.revision !== revision) { this.reset(); return; }
    const { telemetry: snapshot, instance, version } = parsed.data;
    if (snapshot.sampledAt > now + 2000 || snapshot.sampledAt < now - 30_000 ||
        snapshot.startedAt > snapshot.sampledAt || snapshot.sampledAt - snapshot.startedAt > 610_000) { this.reset(); return; }
    const previous = this.previous;
    if (previous?.instance === instance && previous.snapshot.revision === revision &&
        (snapshot.sampledAt <= previous.snapshot.sampledAt || snapshot.epoch < previous.snapshot.epoch)) return;
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
/** Each native owner has an independent baseline and failure boundary. */
export class NativeMetricCollector {
  private readonly reader = new NativeMetricReader();
  private busy = false;
  private closed = false;
  private timer?: NodeJS.Timeout;
  constructor(private readonly service: "palmagent.daemon" | "palmagent.application",
    private readonly read: () => Promise<unknown>, private readonly preferencePath: string,
    private readonly producer: TelemetryProducer) {}
  start(): void {
    this.timer = setInterval(() => { void this.poll(); }, 15_000); this.timer.unref();
    void this.poll();
  }
  async poll(): Promise<void> {
    if (this.busy || this.closed) return;
    const { producer, preferencePath } = this;
    producer.refresh();
    const choice = readTelemetryChoice(preferencePath);
    if (!producer.active || !choice?.enabled) { this.reader.reset(); return; }
    this.busy = true;
    try {
      const status = await this.read();
      producer.refresh();
      if (this.closed || !producer.active || readTelemetryChoice(preferencePath)?.revision !== choice.revision) { this.reader.reset(); return; }
      const batch = this.reader.read(status, choice.revision);
      if (batch) producer.enqueue({ service: this.service, version: batch.version, implementation: "rust",
        os: "linux", arch: process.arch === "arm64" ? "arm64" : "amd64", source: "production" }, batch.points, batch.start, batch.end);
    } catch { this.reader.reset(); } // Unavailable/older owners supply no measurements.
    finally { this.busy = false; }
  }
  close(): void { this.closed = true; clearInterval(this.timer); this.reader.reset(); }
}
export function collectNativeMetrics(dataDir: string, preferencePath: string, producer: TelemetryProducer) {
  const owners = [
    new NativeMetricCollector("palmagent.daemon", () => daemonRequest(dataDir, { action: "status" }, 5000), preferencePath, producer),
    new NativeMetricCollector("palmagent.application", async () => {
      const response = await applicationRequest(dataDir, "/telemetry");
      if (response.status !== 200) throw new Error("Native metrics unavailable");
      return response.value;
    }, preferencePath, producer),
  ];
  owners.forEach(owner => owner.start());
  return () => owners.forEach(owner => owner.close());
}
