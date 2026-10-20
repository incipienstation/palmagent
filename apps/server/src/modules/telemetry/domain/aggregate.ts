import { TELEMETRY, TELEMETRY_METRICS, type TelemetryAttributes, type TelemetryMetric, type TelemetryPoint } from "@palmagent/shared/telemetry";

/** Fixed labels, bounded state, and no host/global access. Full buffers drop optional samples. */
export class MetricAggregate {
  private points = new Map<string, TelemetryPoint>();
  constructor(private readonly capacity = 128) {}
  observe(name: TelemetryMetric, value: number, attributes: TelemetryAttributes): void {
    const metric = TELEMETRY_METRICS[name];
    if (!metric || !Number.isFinite(value) || value < 0 || value > metric.max ||
        !TELEMETRY.concurrency.includes(attributes.concurrency)) return;
    const operation = name === "palmagent.operation.duration";
    if (operation && (!TELEMETRY.operations.includes(attributes.operation ?? "") || !TELEMETRY.outcomes.includes(attributes.outcome ?? ""))) return;
    // Rebuild the allowlist instead of retaining caller-owned objects or unknown attributes.
    const attrs = operation ? { concurrency: attributes.concurrency, operation: attributes.operation!, outcome: attributes.outcome! }
      : { concurrency: attributes.concurrency };
    const key = JSON.stringify([name, attrs]);
    let point = this.points.get(key);
    if (!point) {
      if (this.points.size >= this.capacity) return;
      point = { name, attributes: attrs, count: 0, sum: 0, buckets: Array(metric.bounds.length + 1).fill(0) };
      this.points.set(key, point);
    }
    if (point.count >= 100000 || (name === "palmagent.storage.busy_retries" && point.sum + value > 100000)) return;
    point.count++; point.sum += value;
    const index = metric.bounds.findIndex(bound => value <= bound);
    point.buckets[index < 0 ? metric.bounds.length : index]++;
  }
  drain(): TelemetryPoint[] { const points = [...this.points.values()]; this.clear(); return points; }
  clear(): void { this.points.clear(); }
}
