/** Optional diagnostics must never affect the operation being measured. No content-bearing labels. */
export interface PerformanceMeasurements {
  beginOperation(name: string, concurrency: number): (outcome: "success" | "error" | "timeout") => void;
  operation(name: string, seconds: number, outcome: "success" | "error" | "timeout", concurrency: number): void;
  busyRetries(count: number, concurrency: number): void;
}
