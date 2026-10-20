import { lstatSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { TelemetryChoiceSchema, type TelemetryChoice, type TelemetryStatus } from "@palmagent/shared/telemetry";
import { writePrivateFileAtomic } from "../../../../platform/filesystem/private-files.js";
import type { TelemetrySettings } from "../../application/ports/inbound/settings.js";

/** Separate file protects this choice from retained older config.json writers. */
export function readTelemetryChoice(path: string): TelemetryChoice | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 4096) return undefined;
    return TelemetryChoiceSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch { return undefined; } // Missing/corrupt/unsupported preferences always stop optional collection.
}
export function telemetrySettings(path: string, changed: () => void, available: boolean): TelemetrySettings {
  const status = (): TelemetryStatus => {
    const choice = readTelemetryChoice(path);
    return { enabled: choice?.enabled ?? true, pendingDisclosure: !choice, available };
  };
  return {
    status,
    change(enabled) {
      writePrivateFileAtomic(path, JSON.stringify({ schemaVersion: 1, enabled, disclosed: true, revision: randomUUID() }) + "\n");
      changed();
      return status();
    },
  };
}
