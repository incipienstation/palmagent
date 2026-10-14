import type { InstallConfig } from "../../domain/installation.js";
import type { InstallationRuntime } from "../ports/outbound/installation.js";

/** An admission barrier must already be held before consulting runtime activity. */
export async function verifyIndependentActivation(runtime: InstallationRuntime, config: InstallConfig): Promise<boolean> {
  runtime.verifyCompatibility(config);
  const activity = await runtime.activity(config);
  if (!activity.verified || !activity.healthy || !activity.maintenance || activity.executionProtocol !== 1) throw new Error("Cannot verify independent application activation");
  if (config.supervisor && !Number.isSafeInteger(activity.activeRoutineScripts)) throw new Error("Cannot verify routine script activity");
  const blocking = activity.updateBlockingRoutineScripts ?? activity.activeRoutineScripts ?? 0;
  if (!Number.isSafeInteger(blocking) || blocking < 0) throw new Error("Cannot verify routine script update safety");
  return blocking === 0;
}
