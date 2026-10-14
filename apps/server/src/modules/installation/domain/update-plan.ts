import { compatiblePlugin, compareProductVersions, validateUpdateTarget, type ReleaseChannel } from "./release-policy.js";

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
