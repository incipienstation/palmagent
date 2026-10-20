import { z } from "zod";
import { lstatSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { TelemetryChoiceSchema, type TelemetryChoice, type TelemetryStatus } from "@palmagent/shared/telemetry";
import { writePrivateFileAtomic } from "../../../../platform/filesystem/private-files.js";
import type { TelemetrySettings } from "../../application/ports/inbound/settings.js";

const LegacyOptOutSchema = TelemetryChoiceSchema.extend({ schemaVersion: z.literal(1), enabled: z.literal(false) });

/** Separate file protects this choice from retained older config.json writers. */
export function readTelemetryChoice(path: string): TelemetryChoice | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 4096) return undefined;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    // Preserve a prior opt-out. A prior opt-in needs the 180-day disclosure.
    const legacyOff = LegacyOptOutSchema.safeParse(value);
    return legacyOff.success ? { ...legacyOff.data, schemaVersion: 2 } : TelemetryChoiceSchema.parse(value);
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
      writePrivateFileAtomic(path, JSON.stringify({ schemaVersion: 2, enabled, disclosed: true, revision: randomUUID() }) + "\n");
      changed();
      return status();
    },
  };
}
