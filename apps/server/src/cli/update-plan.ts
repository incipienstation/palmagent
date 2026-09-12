import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BRANDING } from "@palmagent/shared";
import { compatiblePlugin, channelTag, validateUpdateTarget, type ReleaseChannel } from "./release-policy.js";
import { run } from "./sh.js";

export interface PluginVersion { manifest: string; version: string }
export interface UpdatePlan {
  schemaVersion: 1;
  channel: ReleaseChannel;
  currentVersion: string;
  targetVersion: string;
  packageAction: "keep" | "update";
  plugins: Array<PluginVersion & { action: "keep" | "update"; targetVersion: string }>;
  automaticEligible: boolean;
}

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

export function planUpdate(currentVersion: string, targetVersion: string, channel: ReleaseChannel, plugins: PluginVersion[]): UpdatePlan {
  validateUpdateTarget(currentVersion, targetVersion, channel);
  const decisions = plugins.map((plugin) => {
    const keep = compatiblePlugin(targetVersion, plugin.version);
    return { ...plugin, action: keep ? "keep" as const : "update" as const, targetVersion: keep ? plugin.version : targetVersion };
  });
  return {
    schemaVersion: 1, channel, currentVersion, targetVersion,
    packageAction: currentVersion === targetVersion ? "keep" : "update",
    plugins: decisions,
    automaticEligible: compatiblePlugin(currentVersion, targetVersion) && decisions.every((plugin) => plugin.action === "keep"),
  };
}

/** Resolve once. Applying the returned target never reuses a moving dist-tag. */
export function resolveUpdatePlan(current: string, channel: ReleaseChannel, plugins: PluginVersion[], requested?: string): UpdatePlan {
  if (requested !== undefined) validateUpdateTarget(current, requested, channel);
  const spec = requested ?? channelTag(channel);
  const result = run("npm", ["view", `${BRANDING.packageName}@${spec}`, "version", "--json"], { timeout: 30_000 });
  if (!result.ok) throw new Error(`could not resolve ${BRANDING.packageName}@${spec}; the selected channel may not be published yet (no fallback)`);
  let target: unknown;
  try { target = JSON.parse(result.stdout); } catch { throw new Error("npm did not return one exact version"); }
  if (typeof target !== "string") throw new Error("npm did not return one exact version");
  if (requested && target !== requested) throw new Error("npm resolved a different version than requested");
  return planUpdate(current, target, channel, plugins);
}
