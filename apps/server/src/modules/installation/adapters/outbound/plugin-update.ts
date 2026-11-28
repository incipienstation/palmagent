import { DISTRIBUTION } from "@palmagent/shared";
// Native managers own their installation records. Never edit their caches or
// settings; retain exact marketplace checkouts and a private recovery receipt.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { installedPlugin } from "./agent-plugin-package.js";
import { installedPlugins, managers, pluginId, pluginManagers } from "./plugin-managers.js";
import { writePrivateFileAtomic, ensurePrivateParent } from "../../../../platform/filesystem/private-files.js";
import type { InstallConfig } from "./config.js";
import { readPluginVersions, type PluginVersion, type UpdatePlan } from "./update-plan.js";
import { run } from "./sh.js";
import { compatiblePlugin, compareProductVersions, productVersion } from "../../domain/release-policy.js";
import { discoveryCommandFailure, UpdateDiscoveryError } from "./update-discovery-error.js";

const repository = `${DISTRIBUTION.repositoryUrl}.git`;
import type { NativePlugin } from "../../domain/installation-observations.js";
export type { NativePlugin } from "../../domain/installation-observations.js";
type Context = Pick<NativePlugin, "manager" | "home" | "cwd">;
export type PluginCommand = typeof run;

function command(context: Context, args: string[], execute: PluginCommand, timeout?: number): string {
  const result = execute(context.manager, ["plugin", ...args], {
    env: { ...process.env, [pluginManagers[context.manager].homeVariable]: context.home },
    cwd: context.cwd, timeout: timeout ?? (args.includes("--help") || args[0] === "list" || args[1] === "list" ? 5_000 : 120_000),
  });
  if (!result.ok) throw new UpdateDiscoveryError(discoveryCommandFailure(`${context.manager}-plugins`, result), `${context.manager} plugin ${args[0]} failed; inspect the native manager before retrying`);
  return result.stdout;
}

/** Only existing installations belonging to the installation owner participate. */
export function discoverPlugins(cfg: Pick<InstallConfig, "claudeConfigDir">, execute: PluginCommand = run): NativePlugin[] {
  const result: NativePlugin[] = [];
  // Retry only a read-only inventory timeout, once across all managers. Three
  // initial inventories (Codex and up to two Claude homes) plus this retry take
  // at most 25s, leaving room for npm's 30s lookup inside the 60s CLI bridge.
  let retried = false;
  function readInventory(context: Context): string {
    const args = pluginManagers[context.manager].listArgs;
    try { return command(context, args, execute); }
    catch (error) {
      if (retried || !(error instanceof UpdateDiscoveryError) || error.failure.code !== "timeout") throw error;
      retried = true;
      return command(context, args, execute, 10_000);
    }
  }
  for (const manager of managers) {
    for (const home of pluginManagers[manager].homes(cfg)) {
      if (!existsSync(join(home, "plugins"))) continue;
      result.push(...installedPlugins(manager, home, () => readInventory({ manager, home, cwd: home })));
    }
  }
  return result;
}

export function participatingPlugins(native: NativePlugin[], manifests: string[]): PluginVersion[] {
  // Older skills pass the native compatibility manifest. Its inventory entry
  // already verified that it agrees with the portable manifest in this package.
  const participants = new Map(native.map(({ manifest, version }) => [manifest, { manifest, version }]));
  const overlays = new Set<string>();
  for (const plugin of native) {
    const directory = dirname(plugin.manifest);
    const nativeDirectory = pluginManagers[plugin.manager].nativeDirectory;
    if (basename(directory) !== nativeDirectory) overlays.add(join(directory, nativeDirectory, "plugin.json"));
  }
  for (const plugin of readPluginVersions(manifests)) {
    if (!overlays.has(plugin.manifest)) participants.set(plugin.manifest, plugin);
  }
  return [...participants.values()];
}

function dedicatedCatalog(root: string, manager: NativePlugin["manager"]): void {
  const catalog = JSON.parse(readFileSync(join(root, pluginManagers[manager].marketplaceFile), "utf8"));
  if (catalog.name !== "palmagent" || !Array.isArray(catalog.plugins) || catalog.plugins.length !== 1 || catalog.plugins[0].name !== "palmagent") {
    throw new Error("Only a dedicated Palmagent marketplace can be refreshed automatically");
  }
}

function registration(plugin: NativePlugin, execute: PluginCommand) {
  const raw = JSON.parse(command(plugin, ["marketplace", "list", "--json"], execute));
  return pluginManagers[plugin.manager].registration(raw, plugin);
}

function stageRelease(dataDir: string, target: string, execute: PluginCommand): string {
  productVersion(target);
  const parent = join(dataDir, "operator-plugins");
  ensurePrivateParent(parent);
  const checkout = join(parent, `${target}-${randomUUID()}`);
  if (!execute("git", ["clone", "--depth", "1", "--branch", `v${target}`, repository, checkout], { timeout: 120_000 }).ok) {
    throw new Error("Could not stage the exact published plugin release");
  }
  const ref = execute("git", ["-C", checkout, "describe", "--tags", "--exact-match", "HEAD"], { timeout: 10_000 });
  if (!ref.ok || ref.stdout.trim() !== `v${target}`) throw new Error("Staged plugin tag does not match the planned release");
  for (const manager of managers) {
    const adapter = pluginManagers[manager];
    const root = join(checkout, adapter.marketplaceRoot);
    dedicatedCatalog(root, manager);
    if (installedPlugin(join(root, adapter.packagePath), adapter.nativeDirectory).version !== target) {
      throw new Error("Staged plugin manifest does not match the planned release");
    }
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
    const adapter = pluginManagers[plugin.manager];
    adapter.assertRefreshable(plugin);
    const original = registration(plugin, execute);
    dedicatedCatalog(original.root, plugin.manager);
    for (const args of [["marketplace", "add"], ...(adapter.removeBeforeAdd ? [["marketplace", "remove"]] : []), [adapter.installCommand]]) {
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
    const adapter = pluginManagers[plugin.manager];
    const targetRoot = join(checkout, adapter.marketplaceRoot);
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
      if (adapter.removeBeforeAdd) {
        command(plugin, ["marketplace", "remove", "palmagent"], execute);
        registrationChanged = true;
      }
      command(plugin, ["marketplace", "add", targetRoot, ...adapter.scopeArgs(plugin)], execute);
      registrationChanged = true;
      if (resolve(registration(plugin, execute).root) !== resolve(targetRoot)) throw new Error("Native manager retained the previous marketplace source");
      command(plugin, [adapter.installCommand, pluginId, ...adapter.scopeArgs(plugin)], execute);
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
          if (adapter.removeBeforeAdd) execute(plugin.manager, ["plugin", "marketplace", "remove", "palmagent"], {
            env: { ...process.env, [adapter.homeVariable]: plugin.home }, cwd: plugin.cwd, timeout: 120_000,
          });
          command(plugin, ["marketplace", "add", ...original.args], execute);
          restored = resolve(registration(plugin, execute).root) === resolve(original.root);
          if (restored && adapter.removeBeforeAdd) {
            // Removing a Codex marketplace also unregisters its plugin. Merely
            // adding the old catalog would leave the user without the plugin.
            command(plugin, [adapter.installCommand, pluginId, ...adapter.scopeArgs(plugin)], execute);
            const actual = discoverPlugins(cfg, execute).find((p) => p.manager === plugin.manager && p.home === plugin.home);
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
