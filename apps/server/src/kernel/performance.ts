export type MeasurementOutcome = "success" | "error" | "timeout" | "client_error" | "unavailable" | "rejected" | "cancelled";

/** Optional diagnostics must never affect the operation being measured. No content-bearing labels. */
export interface PerformanceMeasurements {
  beginOperation(name: string, concurrency: number): (outcome: MeasurementOutcome) => void;
  operation(name: string, seconds: number, outcome: MeasurementOutcome, concurrency: number): void;
  busyRetries(count: number, concurrency: number): void;
}
