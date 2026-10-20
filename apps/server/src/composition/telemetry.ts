import { dirname, join } from "node:path";
import { type TelemetryService } from "@palmagent/shared/telemetry";
import { userConfigPath } from "../modules/installation/adapters/outbound/user-config.js";
import { TelemetryProducer } from "../modules/telemetry/adapters/outbound/producer.js";
import { telemetrySettings } from "../modules/telemetry/adapters/outbound/preference.js";

declare const __PALMAGENT_BUILD__: { version: string; sourceCommit: string; dirty: boolean };
export function createTelemetry(service: TelemetryService, concurrency: () => number,
  build = typeof __PALMAGENT_BUILD__ === "undefined" ? undefined : __PALMAGENT_BUILD__, allowed = process.env.NODE_ENV === "production") {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  const available = allowed && !!build && !build.dirty && /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-alpha\.\d{1,6})?$/.test(build.version) &&
    ["linux", "darwin", "windows"].includes(os) && ["amd64", "arm64"].includes(arch);
  const preferencePath = join(dirname(userConfigPath()), "telemetry.json");
  const producer = new TelemetryProducer({ preferencePath, available, concurrency,
    resource: { service, version: build?.version ?? "0.0.0", implementation: "node",
      os: os as "linux" | "darwin" | "windows", arch: arch as "amd64" | "arm64", source: "production" } });
  return { producer, preferencePath, settings: telemetrySettings(preferencePath, () => producer.refresh(), available) };
}
