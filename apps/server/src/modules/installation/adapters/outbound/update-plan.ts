import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BRANDING } from "@palmagent/shared";
import { compatiblePlugin, channelTag, compareProductVersions, productVersion, validateUpdateTarget, type ReleaseChannel } from "../../domain/release-policy.js";
import { run } from "./sh.js";
import { discoveryCommandFailure, discoveryStep, UpdateDiscoveryError } from "./update-discovery-error.js";

export interface PluginVersion { manifest: string; version: string }
export interface UpdatePlan {
  schemaVersion: 1;
  pluginManagement: "native";
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
    const keep = compatiblePlugin(targetVersion, plugin.version) && compareProductVersions(plugin.version, targetVersion) >= 0;
    return { ...plugin, action: keep ? "keep" as const : "update" as const, targetVersion: keep ? plugin.version : targetVersion };
  });
  return {
    schemaVersion: 1, pluginManagement: "native", channel, currentVersion, targetVersion,
    packageAction: currentVersion === targetVersion ? "keep" : "update",
    plugins: decisions,
    automaticEligible: compatiblePlugin(currentVersion, targetVersion) && plugins.every((plugin) => compatiblePlugin(targetVersion, plugin.version)),
  };
}

/** Resolve once. Applying the returned target never reuses a moving dist-tag. */
export function resolveUpdatePlan(current: string, channel: ReleaseChannel, plugins: PluginVersion[], requested?: string): UpdatePlan {
  if (requested !== undefined) validateUpdateTarget(current, requested, channel);
  const spec = requested ?? channelTag(channel);
  const result = run("npm", ["view", `${BRANDING.packageName}@${spec}`, "version", "--json"], { timeout: 30_000 });
  if (!result.ok) throw new UpdateDiscoveryError(discoveryCommandFailure("registry", result), "Could not query the package registry");
  const target = discoveryStep({ source: "registry", code: "invalid-response" }, "npm did not return one exact version", () => {
    const value: unknown = JSON.parse(result.stdout);
    if (typeof value !== "string" || (requested && value !== requested)) throw new Error("invalid registry version");
    productVersion(value);
    return value;
  });
  return discoveryStep({ source: "release-policy", code: "incompatible-release" }, "The registry release does not match the selected channel or installed version", () => planUpdate(current, target, channel, plugins));
}
