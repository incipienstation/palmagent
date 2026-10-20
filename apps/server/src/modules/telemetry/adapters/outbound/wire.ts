import { TELEMETRY_METRICS, type TelemetryMetric, type TelemetryPoint, type TelemetryResource } from "@palmagent/shared/telemetry";

export const attributes = (values: Record<string, string>) =>
  Object.entries(values).map(([key, stringValue]) => ({ key, value: { stringValue } }));

export function metricPayload(resource: TelemetryResource, points: TelemetryPoint[], start: number, end: number) {
  return { resourceMetrics: [{
    resource: { attributes: attributes({
      "service.name": resource.service, "service.version": resource.version, "runtime.implementation": resource.implementation,
      "os.type": resource.os, "host.arch": resource.arch, "telemetry.source": resource.source,
    }) },
    scopeMetrics: [{ scope: { name: "palmagent.telemetry", version: "1" }, metrics: points.map(point => {
      const metric = TELEMETRY_METRICS[point.name as TelemetryMetric];
      const sum = point.name === "palmagent.storage.busy_retries";
      return { name: point.name, unit: metric.unit, [sum ? "sum" : "histogram"]: {
        aggregationTemporality: 1, ...(sum ? { isMonotonic: true } : {}),
        dataPoints: [{
          attributes: attributes(point.attributes), startTimeUnixNano: String(BigInt(Math.floor(start)) * 1000000n),
          timeUnixNano: String(BigInt(Math.floor(end)) * 1000000n),
          ...(sum ? { asInt: String(point.sum) } : { count: point.count, sum: point.sum, bucketCounts: point.buckets, explicitBounds: metric.bounds }),
        }],
      } };
    }) }],
  }] };
}
