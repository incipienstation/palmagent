import { BRANDING, DISTRIBUTION } from "@palmagent/shared";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { productVersion } from "../../domain/release-policy.js";
import type { PluginVersion } from "../../domain/update-plan.js";

function readManifest(manifest: string, portable = false): PluginVersion {
  let value;
  try { value = JSON.parse(readFileSync(manifest, "utf8")); }
  catch { throw new Error("cannot read an installed Palmagent plugin manifest"); }
  if (!value || value.name !== BRANDING.packageName || typeof value.version !== "string") {
    throw new Error("expected a Palmagent plugin manifest with an exact version");
  }
  if (portable && value.$schema !== DISTRIBUTION.agentPluginSchema) throw new Error("Unsupported Agent Plugins manifest schema");
  productVersion(value.version);
  return { manifest, version: value.version };
}

/** The portable package owns identity. Older releases carry only a native manifest. */
export function installedPlugin(root: string, nativeDirectory: string): PluginVersion {
  const native = join(root, nativeDirectory, "plugin.json");
  const portable = join(root, "plugin.json");
  if (!existsSync(portable)) return readManifest(native);
  const plugin = readManifest(portable, true);
  if (existsSync(native) && readManifest(native).version !== plugin.version) {
    throw new Error("Native and portable Palmagent manifests disagree");
  }
  return plugin;
}

export function readPluginVersions(paths: string[]): PluginVersion[] {
  return [...new Set(paths.map(path => resolve(path)))].map(path => readManifest(path));
}
