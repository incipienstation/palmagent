import { compatiblePlugin, compareProductVersions, validateUpdateTarget, type ReleaseChannel } from "./release-policy.js";
import type { Distribution, StandaloneSelection } from "@palmagent/shared/standalone";

export interface PluginVersion { manifest: string; version: string }
export interface UpdatePlan {
  schemaVersion: 2;
  pluginManagement: "native";
  channel: ReleaseChannel;
  currentVersion: string;
  targetVersion: string;
  packageAction: "keep" | "update";
  action: "keep" | "update" | "migrate" | "repair";
  currentDistribution: Distribution;
  targetDistribution: Distribution;
  selection?: StandaloneSelection;
  plugins: Array<PluginVersion & { action: "keep" | "update"; targetVersion: string }>;
  automaticEligible: boolean;
}

export function planUpdate(currentVersion: string, targetVersion: string, channel: ReleaseChannel, plugins: PluginVersion[],
  currentDistribution: Distribution = "npm", targetDistribution: Distribution = currentDistribution, selection?: StandaloneSelection): UpdatePlan {
  validateUpdateTarget(currentVersion, targetVersion, channel);
  const decisions = plugins.map((plugin) => {
    const keep = compatiblePlugin(targetVersion, plugin.version) && compareProductVersions(plugin.version, targetVersion) >= 0;
    return { ...plugin, action: keep ? "keep" as const : "update" as const, targetVersion: keep ? plugin.version : targetVersion };
  });
  return {
    schemaVersion: 2, pluginManagement: "native", channel, currentVersion, targetVersion,
    currentDistribution, targetDistribution, ...(selection ? { selection } : {}),
    action: currentDistribution !== targetDistribution ? "migrate" : currentVersion === targetVersion ? "keep" : "update",
    packageAction: currentVersion === targetVersion && currentDistribution === targetDistribution ? "keep" : "update",
    plugins: decisions,
    automaticEligible: compatiblePlugin(currentVersion, targetVersion) && plugins.every((plugin) => compatiblePlugin(targetVersion, plugin.version)),
  };
}
