import { z } from "zod";
import contract from "./telemetry-contract.json" with { type: "json" };

/** Also consumed by the Rust supervisor. Changing a boundary requires a new metric version. */
export const TELEMETRY = contract;
export const TELEMETRY_ENDPOINT = "https://telemetry.palmagent.dev/v1/metrics";
export const TelemetryChoiceSchema = z.object({
  schemaVersion: z.literal(1), enabled: z.boolean(), disclosed: z.literal(true), revision: z.string().uuid(),
}).strict();
export type TelemetryChoice = z.infer<typeof TelemetryChoiceSchema>;
export const TelemetryChangeSchema = z.object({ enabled: z.boolean() }).strict();
export type TelemetryStatus = {
  enabled: boolean; pendingDisclosure: boolean; available: boolean;
};
export type TelemetryAttributes = { concurrency: string; operation?: string; outcome?: string };
export type TelemetryPoint = {
  name: string; attributes: TelemetryAttributes; count: number; sum: number; buckets: number[];
};
export const TELEMETRY_METRICS = {
  "palmagent.operation.duration": { unit: "s", bounds: contract.bounds.duration, max: 3600 },
  "palmagent.process.cpu.utilization": { unit: "1", bounds: contract.bounds.cpu, max: 64 },
  "palmagent.process.memory.usage": { unit: "By", bounds: contract.bounds.memory, max: 68719476736 },
  "palmagent.runtime.event_loop.delay": { unit: "s", bounds: contract.bounds.duration, max: 3600 },
  "palmagent.storage.busy_retries": { unit: "1", bounds: [], max: 100000 },
} as const;
export type TelemetryMetric = keyof typeof TELEMETRY_METRICS;
export type TelemetryService = "palmagent.web" | "palmagent.daemon" | "palmagent.execution" | "palmagent.terminal";
export type TelemetryResource = {
  service: TelemetryService; version: string; implementation: "node" | "rust";
  os: "linux" | "darwin" | "windows"; arch: "amd64" | "arm64"; source: "production" | "synthetic";
};
export function concurrencyBucket(n: number): string {
  return n <= 0 ? "0" : n === 1 ? "1" : n <= 4 ? "2-4" : n <= 8 ? "5-8" : n <= 16 ? "9-16" : "17+";
}
