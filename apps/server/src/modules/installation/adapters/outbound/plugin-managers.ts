import { BRANDING } from "@palmagent/shared";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { NativePlugin } from "../../domain/installation-observations.js";
import type { InstallConfig } from "./config.js";
import { productVersion } from "../../domain/release-policy.js";
import { installedPlugin } from "./agent-plugin-package.js";
import { discoveryStep, UpdateDiscoveryError } from "./update-discovery-error.js";

type Manager = NativePlugin["manager"];
export type Registration = { root: string; args: string[] };
type Entry = Pick<NativePlugin, "scope" | "enabled" | "policy" | "cwd" | "version"> & { root: string };

interface PluginManager {
  homeVariable: string;
  homes(config: Pick<InstallConfig, "claudeConfigDir">): string[];
  listArgs: string[];
  inventory(raw: unknown, home: string): Entry[];
  nativeDirectory: string;
  marketplaceFile: string;
  marketplaceRoot: string;
  packagePath: string;
  registration(raw: unknown, plugin: NativePlugin): Registration;
  assertRefreshable(plugin: NativePlugin): void;
  removeBeforeAdd: boolean;
  scopeArgs(plugin: NativePlugin): string[];
  installCommand: string;
}

export const pluginId = `${BRANDING.packageName}@${BRANDING.packageName}`;
const codexInventory = z.object({ installed: z.array(z.object({
  pluginId: z.string(), version: z.string(), enabled: z.boolean(), installPolicy: z.string(),
})) });
const claudeIdentities = z.array(z.object({ id: z.string().min(1) }).passthrough());
const claudeInstall = z.object({ version: z.string(), enabled: z.boolean(), scope: z.string(),
  installPath: z.string().min(1), projectPath: z.string().optional() });

export const pluginManagers: Record<Manager, PluginManager> = {
  codex: {
    homeVariable: "CODEX_HOME",
    homes: () => [resolve(process.env.CODEX_HOME || join(homedir(), ".codex"))],
    listArgs: ["list", "--json", "--marketplace", BRANDING.packageName],
    inventory(raw, home) {
      const { installed } = codexInventory.parse(raw);
      if (installed.some(p => p.pluginId.endsWith("@palmagent") && p.pluginId !== pluginId)) {
        throw new UpdateDiscoveryError({ source: "codex-plugins", code: "invalid-plugin" }, "Palmagent marketplace has unrelated installed plugins");
      }
      return installed.filter(p => p.pluginId === pluginId).map(p => ({
        version: p.version, scope: "user", cwd: home, enabled: p.enabled, policy: p.installPolicy,
        root: join(home, "plugins/cache/palmagent/palmagent", p.version),
      }));
    },
    nativeDirectory: ".codex-plugin", marketplaceFile: ".agents/plugins/marketplace.json",
    marketplaceRoot: "plugins/codex", packagePath: "plugins/palmagent",
    registration(raw) {
      const entry = z.object({ marketplaces: z.array(z.object({ name: z.string(), root: z.string(),
        marketplaceSource: z.object({ sourceType: z.string(), source: z.string(), ref: z.string().optional() }).optional(),
      })) }).parse(raw).marketplaces.find(p => p.name === "palmagent");
      if (!entry?.marketplaceSource) throw new Error("Cannot preserve the Codex marketplace source");
      const source = entry.marketplaceSource;
      if (!["local", "git"].includes(source.sourceType)) throw new Error("Unsupported Codex marketplace source");
      return { root: entry.root, args: [source.source, ...(source.ref ? ["--ref", source.ref] : [])] };
    },
    assertRefreshable(plugin) {
      if (plugin.policy !== "AVAILABLE" || !plugin.enabled) {
        throw new Error("Codex managed or disabled plugins require their native administrator; state was preserved");
      }
    },
    removeBeforeAdd: true, scopeArgs: () => [], installCommand: "add",
  },
  claude: {
    homeVariable: "CLAUDE_CONFIG_DIR",
    homes: config => [...new Set([process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), config.claudeConfigDir]
      .filter(Boolean).map(path => resolve(path)))],
    listArgs: ["list", "--json"],
    inventory(raw, home) {
      // Built-ins have an identity but no installation directory.
      return claudeIdentities.parse(raw).filter(p => p.id === pluginId).map(row => {
        const p = claudeInstall.parse(row);
        return { version: p.version, scope: p.scope, enabled: p.enabled, cwd: p.projectPath || home, root: p.installPath };
      });
    },
    nativeDirectory: ".claude-plugin", marketplaceFile: ".claude-plugin/marketplace.json",
    marketplaceRoot: ".", packagePath: "plugins/claude",
    registration(raw, plugin) {
      const entry = z.array(z.object({ name: z.string(), source: z.string(), installLocation: z.string(),
        path: z.string().optional(), repo: z.string().optional(), url: z.string().optional(), ref: z.string().optional(),
      })).parse(raw).find(p => p.name === "palmagent");
      if (!entry) throw new Error("Cannot preserve the Claude marketplace source");
      const source = entry.source === "directory" ? entry.path : entry.source === "github" ? entry.repo : entry.source === "git" ? entry.url : undefined;
      if (!source) throw new Error("Unsupported Claude marketplace source");
      return { root: entry.installLocation, args: [source + (entry.ref ? `#${entry.ref}` : ""), "--scope", plugin.scope] };
    },
    assertRefreshable(plugin) {
      if (!["user", "project", "local"].includes(plugin.scope) || (plugin.scope !== "user" && plugin.cwd === plugin.home)) {
        throw new Error("Claude plugin scope cannot be refreshed safely; managed installations remain managed");
      }
    },
    removeBeforeAdd: false, scopeArgs: plugin => ["--scope", plugin.scope], installCommand: "update",
  },
};

export const managers = Object.keys(pluginManagers) as Manager[];

export function installedPlugins(manager: Manager, home: string, read: () => string): NativePlugin[] {
  const adapter = pluginManagers[manager];
  const source = `${manager}-plugins` as const;
  const entries = discoveryStep({ source, code: "invalid-response" }, `Invalid ${manager} plugin inventory`,
    () => adapter.inventory(JSON.parse(read()), home));
  return discoveryStep({ source, code: "invalid-plugin" }, `Could not verify installed ${manager} plugin manifests`, () =>
    entries.map(({ root, version: reported, ...entry }) => {
      productVersion(reported);
      const manifest = installedPlugin(root, adapter.nativeDirectory);
      if (reported !== manifest.version) throw new UpdateDiscoveryError({ source, code: "invalid-plugin" }, `${manager} installed manifest does not match its inventory`);
      return { manager, home, ...entry, ...manifest };
    }));
}
