import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BRANDING } from "@palmagent/shared";
import { compatiblePlugin, channelTag, productVersion, validateUpdateTarget, type ReleaseChannel } from "../../domain/release-policy.js";
import { run } from "./sh.js";
import { discoveryCommandFailure, discoveryStep, UpdateDiscoveryError } from "./update-discovery-error.js";

import { planUpdate } from "../../domain/update-plan.js";
import type { PluginVersion, UpdatePlan } from "../../domain/update-plan.js";
export { planUpdate } from "../../domain/update-plan.js";
export type { PluginVersion, UpdatePlan } from "../../domain/update-plan.js";

export function readPluginVersions(paths: string[]): PluginVersion[] {
  return [...new Set(paths.map((path) => resolve(path)))].map((manifest) => {
    let value;
    try { value = JSON.parse(readFileSync(manifest, "utf8")); }
    catch { throw new Error("cannot read an installed Palmagent plugin manifest"); }
    if (!value || value.name !== BRANDING.packageName || typeof value.version !== "string") {
      throw new Error("expected a Palmagent plugin manifest with an exact version");
    }
    // Validate even when there is no newer package.
    compatiblePlugin(value.version, value.version);
    return { manifest, version: value.version };
  });
}

/** Resolve once. Applying the returned target never reuses a moving dist-tag. */
export function resolveUpdatePlan(current: string, channel: ReleaseChannel, plugins: PluginVersion[], requested?: string): UpdatePlan {
  if (requested !== undefined) validateUpdateTarget(current, requested, channel);
  const spec = requested ?? channelTag(channel);
  const result = run("npm", ["view", `${BRANDING.packageName}@${spec}`, "version", "--json"], { timeout: 30_000 });
  if (!result.ok) throw new UpdateDiscoveryError(discoveryCommandFailure("registry", result), `could not resolve ${BRANDING.packageName}@${spec}; the selected channel may not be published yet (no fallback)`);
  const target = discoveryStep({ source: "registry", code: "invalid-response" }, "npm did not return one exact version", () => {
    const value: unknown = JSON.parse(result.stdout);
    if (typeof value !== "string" || (requested && value !== requested)) throw new Error("invalid registry version");
    productVersion(value);
    return value;
  });
  try { return planUpdate(current, target, channel, plugins); }
  catch (error) {
    // Keep the CLI's existing channel/downgrade explanation; only the category
    // crosses into persisted discovery diagnostics.
    throw new UpdateDiscoveryError({ source: "release-policy", code: "incompatible-release" }, error instanceof Error ? error.message : "Incompatible release");
  }
}
