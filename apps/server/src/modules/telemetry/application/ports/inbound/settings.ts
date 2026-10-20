import type { TelemetryStatus } from "@palmagent/shared/telemetry";
export interface TelemetrySettings {
  status(): TelemetryStatus;
  change(enabled: boolean): TelemetryStatus;
}
