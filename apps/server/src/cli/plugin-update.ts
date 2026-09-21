// Native managers own their installation records. Never edit their caches or
// settings; retain exact marketplace checkouts and a private recovery receipt.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { writePrivateFileAtomic, ensurePrivateParent } from "../private-files.js";
import type { InstallConfig } from "./config.js";
import { readPluginVersions, type PluginVersion, type UpdatePlan } from "./update-plan.js";
import { run } from "./sh.js";
import { compatiblePlugin, compareProductVersions } from "./release-policy.js";

const id = "palmagent@palmagent";
const repository = "https://github.com/incipienstation/palmagent.git";
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/);
const codexInventory = z.object({ installed: z.array(z.object({
  pluginId: z.string(), version: z.string(), enabled: z.boolean(), installPolicy: z.string(),
})) });
const claudeInventory = z.array(z.object({
  id: z.string(), version: z.string(), enabled: z.boolean(), scope: z.string(),
  installPath: z.string(), projectPath: z.string().optional(),
}));

export interface NativePlugin extends PluginVersion {
  manager: "codex" | "claude";
  home: string;
  scope: string;
  cwd: string;
  enabled: boolean;
  policy?: string;
}
type Context = Pick<NativePlugin, "manager" | "home" | "cwd">;
export type PluginCommand = typeof run;

function command(context: Context, args: string[], execute: PluginCommand): string {
  const result = execute(context.manager, ["plugin", ...args], {
    env: { ...process.env, [context.manager === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]: context.home },
    cwd: context.cwd, timeout: args.includes("--help") || args[0] === "list" || args[1] === "list" ? 5_000 : 120_000,
  });
  if (!result.ok) throw new Error(`${context.manager} plugin ${args[0]} failed; inspect the native manager before retrying`);
  return result.stdout;
}

/** Only existing installations belonging to the installation owner participate. */
export function discoverPlugins(cfg: Pick<InstallConfig, "claudeConfigDir">, execute: PluginCommand = run): NativePlugin[] {
  const result: NativePlugin[] = [];
  const codexHome = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
  if (existsSync(join(codexHome, "plugins"))) {
    const context = { manager: "codex" as const, home: codexHome, cwd: codexHome };
    const inventory = codexInventory.parse(JSON.parse(command(context, ["list", "--json"], execute)));
    if (inventory.installed.some((p) => p.pluginId.endsWith("@palmagent") && p.pluginId !== id)) throw new Error("Palmagent marketplace has unrelated installed plugins");
    for (const plugin of inventory.installed.filter((p) => p.pluginId === id)) {
      version.parse(plugin.version);
      result.push({ ...context, scope: "user", enabled: plugin.enabled, policy: plugin.installPolicy,
        ...readPluginVersions([join(codexHome, "plugins/cache/palmagent/palmagent", plugin.version, ".codex-plugin/plugin.json")])[0] });
      if (result.at(-1)!.version !== plugin.version) throw new Error("Codex installed manifest does not match its inventory");
    }
  }
  const homes = new Set([process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), cfg.claudeConfigDir].filter(Boolean).map((p) => resolve(p)));
  for (const home of homes) {
    if (!existsSync(join(home, "plugins"))) continue;
    const context = { manager: "claude" as const, home, cwd: home };
    const inventory = claudeInventory.parse(JSON.parse(command(context, ["list", "--json"], execute)));
    for (const plugin of inventory.filter((p) => p.id === id)) {
      version.parse(plugin.version);
      const manifest = readPluginVersions([join(plugin.installPath, ".claude-plugin/plugin.json")])[0];
      if (manifest.version !== plugin.version) throw new Error("Claude installed manifest does not match its inventory");
      result.push({ ...context, ...manifest, scope: plugin.scope, enabled: plugin.enabled,
        cwd: plugin.projectPath || home });
    }
  }
  return result;
}

export function participatingPlugins(native: NativePlugin[], manifests: string[]): PluginVersion[] {
  return readPluginVersions([...native.map((plugin) => plugin.manifest), ...manifests]);
}

function dedicatedCatalog(root: string, manager: NativePlugin["manager"]): void {
  const catalog = JSON.parse(readFileSync(join(root, manager === "codex" ? ".agents/plugins/marketplace.json" : ".claude-plugin/marketplace.json"), "utf8"));
  if (catalog.name !== "palmagent" || !Array.isArray(catalog.plugins) || catalog.plugins.length !== 1 || catalog.plugins[0].name !== "palmagent") {
    throw new Error("Only a dedicated Palmagent marketplace can be refreshed automatically");
  }
}

type Registration = { root: string; args: string[] };
function registration(plugin: NativePlugin, execute: PluginCommand): Registration {
  const raw = JSON.parse(command(plugin, ["marketplace", "list", "--json"], execute));
  if (plugin.manager === "codex") {
    const entry = z.object({ marketplaces: z.array(z.object({ name: z.string(), root: z.string(),
      marketplaceSource: z.object({ sourceType: z.string(), source: z.string(), ref: z.string().optional() }).optional(),
    })) }).parse(raw).marketplaces.find((p) => p.name === "palmagent");
    if (!entry?.marketplaceSource) throw new Error("Cannot preserve the Codex marketplace source");
    const source = entry.marketplaceSource;
    if (!["local", "git"].includes(source.sourceType)) throw new Error("Unsupported Codex marketplace source");
    return { root: entry.root, args: [source.source, ...(source.ref ? ["--ref", source.ref] : [])] };
  }
  const entry = z.array(z.object({ name: z.string(), source: z.string(), installLocation: z.string(),
    path: z.string().optional(), repo: z.string().optional(), url: z.string().optional(), ref: z.string().optional(),
  })).parse(raw).find((p) => p.name === "palmagent");
  if (!entry) throw new Error("Cannot preserve the Claude marketplace source");
  const source = entry.source === "directory" ? entry.path : entry.source === "github" ? entry.repo : entry.source === "git" ? entry.url : undefined;
  if (!source) throw new Error("Unsupported Claude marketplace source");
  return { root: entry.installLocation, args: [source + (entry.ref ? `#${entry.ref}` : ""), "--scope", plugin.scope] };
}

function assertRefreshable(plugin: NativePlugin): void {
  if (plugin.manager === "codex" && (plugin.policy !== "AVAILABLE" || !plugin.enabled)) {
    throw new Error("Codex managed or disabled plugins require their native administrator; state was preserved");
  }
  if (plugin.manager === "claude" && (!["user", "project", "local"].includes(plugin.scope) ||
      (plugin.scope !== "user" && plugin.cwd === plugin.home))) {
    throw new Error("Claude plugin scope cannot be refreshed safely; managed installations remain managed");
  }
}

function stageRelease(dataDir: string, target: string, execute: PluginCommand): string {
  version.parse(target);
  const parent = join(dataDir, "operator-plugins");
  ensurePrivateParent(parent);
  const checkout = join(parent, `${target}-${randomUUID()}`);
  if (!execute("git", ["clone", "--depth", "1", "--branch", `v${target}`, repository, checkout], { timeout: 120_000 }).ok) {
    throw new Error("Could not stage the exact published plugin release");
  }
  const ref = execute("git", ["-C", checkout, "describe", "--tags", "--exact-match", "HEAD"], { timeout: 10_000 });
  if (!ref.ok || ref.stdout.trim() !== `v${target}`) throw new Error("Staged plugin tag does not match the planned release");
  for (const [root, manager, manifest] of [
    [join(checkout, "plugins/codex"), "codex", "plugins/palmagent/.codex-plugin/plugin.json"],
    [checkout, "claude", "plugins/claude/.claude-plugin/plugin.json"],
  ] as const) {
    dedicatedCatalog(root, manager);
    if (readPluginVersions([join(root, manifest)])[0].version !== target) throw new Error("Staged plugin manifest does not match the planned release");
  }
  return checkout;
}

/** Runs under the installation update lock, before any application replacement. */
export function refreshPlugins(cfg: InstallConfig, plan: UpdatePlan, native: NativePlugin[], execute: PluginCommand = run): NativePlugin[] {
  const changes = plan.plugins.filter((p) => p.action === "update");
  if (!changes.length) return native;
  const selected = changes.flatMap((change) => {
    const matches = native.filter((p) => p.manifest === change.manifest);
    if (!matches.length) throw new Error("The target needs a matching plugin; refresh the supplied manifest through its native manager");
    return matches;
  });
  // Validate every participant before mutating even the first registration.
  const originals = selected.map((plugin) => {
    if (compareProductVersions(plugin.version, plan.targetVersion) > 0) throw new Error("Refusing to downgrade a newer operator plugin; review the compatibility boundary separately");
    assertRefreshable(plugin);
    const original = registration(plugin, execute);
    dedicatedCatalog(original.root, plugin.manager);
    for (const args of [["marketplace", "add"], ...(plugin.manager === "codex" ? [["marketplace", "remove"]] : []), [plugin.manager === "codex" ? "add" : "update"]]) {
      command(plugin, [...args, "--help"], execute);
    }
    return { plugin, original };
  });
  const checkout = stageRelease(cfg.dataDir, plan.targetVersion, execute);
  const receipt = join(cfg.dataDir, "plugin-update.json");
  const updated: NativePlugin[] = [];
  const save = (status: string) => writePrivateFileAtomic(receipt, JSON.stringify({
    schemaVersion: 1, status, targetVersion: plan.targetVersion, checkout, originals, updated,
    activation: "new-agent-session-required",
  }) + "\n");
  save("applying");
  for (const { plugin, original } of originals) {
    const targetRoot = plugin.manager === "codex" ? join(checkout, "plugins/codex") : checkout;
    let registrationChanged = false;
    try {
      const current = discoverPlugins(cfg, execute).find((p) => p.manager === plugin.manager && p.home === plugin.home && p.scope === plugin.scope && p.cwd === plugin.cwd);
      const source = registration(plugin, execute);
      const sharedRefresh = updated.some((p) => p.manager === plugin.manager && p.home === plugin.home) && resolve(source.root) === resolve(targetRoot);
      if (sharedRefresh && current?.version === plan.targetVersion && current.enabled === plugin.enabled) {
        updated.push(current); save("applying"); continue;
      }
      if (!current || current.version !== plugin.version || current.enabled !== plugin.enabled ||
          (!sharedRefresh && JSON.stringify(source) !== JSON.stringify(original))) {
        throw new Error("Plugin installation changed while staging; check again before refreshing it");
      }
      if (plugin.manager === "codex") {
        command(plugin, ["marketplace", "remove", "palmagent"], execute);
        registrationChanged = true;
      }
      command(plugin, ["marketplace", "add", targetRoot, ...(plugin.manager === "claude" ? ["--scope", plugin.scope] : [])], execute);
      registrationChanged = true;
      if (resolve(registration(plugin, execute).root) !== resolve(targetRoot)) throw new Error("Native manager retained the previous marketplace source");
      command(plugin, plugin.manager === "codex" ? ["add", id] : ["update", id, "--scope", plugin.scope], execute);
      const actual = discoverPlugins(cfg, execute).find((p) => p.manager === plugin.manager && p.home === plugin.home && p.scope === plugin.scope && p.cwd === plugin.cwd);
      if (!actual || actual.version !== plan.targetVersion || actual.enabled !== plugin.enabled) throw new Error("Native plugin installation did not preserve the expected version and enabled state");
      updated.push(actual);
      save("applying");
    } catch (error) {
      // A compatible plugin already installed successfully can remain. Restore
      // the failing participant's catalog; do not guess at cache/file rollback.
      let restored = !registrationChanged;
      if (registrationChanged) {
        try {
          if (plugin.manager === "codex") execute("codex", ["plugin", "marketplace", "remove", "palmagent"], {
            env: { ...process.env, CODEX_HOME: plugin.home }, cwd: plugin.cwd, timeout: 120_000,
          });
          command(plugin, ["marketplace", "add", ...original.args], execute);
          restored = resolve(registration(plugin, execute).root) === resolve(original.root);
          if (restored && plugin.manager === "codex") {
            // Removing a Codex marketplace also unregisters its plugin. Merely
            // adding the old catalog would leave the user without the plugin.
            command(plugin, ["add", id], execute);
            const actual = discoverPlugins(cfg, execute).find((p) => p.manager === "codex" && p.home === plugin.home);
            restored = Boolean(actual && actual.enabled === plugin.enabled && compatiblePlugin(plan.currentVersion, actual.version));
          }
        } catch { restored = false; }
      }
      save(restored ? "failed-catalog-restored" : "failed-recovery-required");
      throw new Error(`${error instanceof Error ? error.message : "Plugin update failed"}; ${restored ? "previous marketplace restored" : "marketplace recovery required"}. See plugin-update.json; installed versions must be rechecked.`);
    }
  }
  save("succeeded");
  return discoverPlugins(cfg, execute);
}
