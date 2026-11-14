import { UpdateSettingsChangeSchema, type UpdateSettingsChange, type UpdateSettingsState, type UpdateSettingsCommandResult } from "@palmagent/shared/updates";
import type { InstallConfig } from "../../domain/installation.js";
import type { UpdateAccessUseCases, UpdateSettingsCommand, UpdateSettingsCommands } from "../ports/inbound/update-settings-command.js";
import type { UpdateAccessStore, UpdateDiscoveryHost, UpdateSettingsHost } from "../ports/outbound/update-settings.js";

export function createUpdateSettings(store: UpdateAccessStore, discovery: UpdateDiscoveryHost, host: UpdateSettingsHost, access: UpdateAccessUseCases): UpdateSettingsCommands {
  function readUpdateSettings(cfg: InstallConfig): NonNullable<UpdateSettingsState["settings"]> {
    const preferences = discovery.preferences(cfg.dataDir);
    const access = store.read(cfg.dataDir);
    if (access.discovery?.channel !== preferences.channel) access.discovery = null;
    if (access.pending && (access.pending.channel !== preferences.channel || (access.pending.automatic && !preferences.autoUpdate))) access.pending = null;
    return {
      distribution: discovery.distribution(cfg),
      channel: preferences.channel,
      autoUpdate: preferences.autoUpdate ?? false,
      independentExecutions: Boolean(cfg.executionNode),
      ...access,
      lastUpdate: store.receipt(cfg.dataDir) ?? null,
    };
  }

  /** The caller holds the shared installation/update lock for a real mutation. */
  async function applyUpdateSettings(cfg: InstallConfig, input: UpdateSettingsChange, dryRun = false): Promise<void> {
    const change = UpdateSettingsChangeSchema.parse(input);
    if ("channel" in change) host.setChannel(cfg, change.channel, dryRun);
    else await host.configureAutomatic(cfg, change.autoUpdate, dryRun);
    if (!dryRun && ("channel" in change || store.read(cfg.dataDir).pending?.automatic)) access.clear(cfg);
  }


  async function execute(command: UpdateSettingsCommand): Promise<UpdateSettingsCommandResult> {
    const action = command.action;
    const changing = action !== "status";
    const change = command.action === "set" ? command.change : undefined;
    let unlock: (() => void) | undefined;
    try {
      if (changing) { unlock = host.lock(); if (!unlock) return { ok: false, error: "busy" }; }
      const { cfg, availability } = host.installation(command.dataDir, command.expectedDb);
      if (changing && (availability !== "available" || !cfg)) return { ok: false, error: "unavailable" };
      if (cfg && changing) {
        if (action === "migrate") {
          if (discovery.distribution(cfg) !== "npm" || access.paused(cfg) || store.read(cfg.dataDir).pending) {
            return { ok: false, error: "stale-update" };
          }
          const checked = access.check(cfg, true, discovery.now(), "standalone");
          if (checked.discovery?.error) return { ok: true, state: { availability, settings: readUpdateSettings(cfg) } };
          try {
            if (!checked.discovery?.selection) throw new Error("standalone release required");
            access.request(cfg, false, checked.discovery.targetVersion ?? undefined);
          } catch { return { ok: false, error: "stale-update" }; }
        }
        if (change) await applyUpdateSettings(cfg, change);
        if (!cfg.supervisor) host.retireTimer();
        const check = action === "visit" || action === "check" || (change && ("channel" in change || change.autoUpdate));
        if (check) {
          const state = access.check(cfg, action !== "visit");
          // Changing channel only checks availability; installation needs a later
          // visit or an explicit Update action in the newly selected channel.
          if (!(change && "channel" in change) && state.discovery?.eligible &&
              (state.discovery.targetVersion !== state.discovery.currentVersion || Boolean(state.discovery.pluginsPending) || state.discovery.packagePending) &&
              discovery.preferences(cfg.dataDir).autoUpdate && !access.paused(cfg)) {
            access.request(cfg, true);
          }
        }
        if (command.action === "install") {
          try { access.request(cfg, false, command.target); }
          catch { return { ok: false, error: "stale-update" }; }
        }
        const pending = store.read(cfg.dataDir).pending;
        if (pending && !access.valid(cfg, pending)) access.clear(cfg, pending.id);
        else if (pending && !access.paused(cfg)) {
          let ready = Boolean(cfg.executionNode);
          if (!ready) {
            ready = host.legacyTasksIdle(cfg.dbPath);
          }
          if (ready) {
            await host.prepare(cfg);
            // The executor also takes this lock; release before asking the supervisor to start it.
            unlock?.(); unlock = undefined;
            await host.start(cfg);
          }
        }
      }
      return { ok: true, state: { availability, settings: cfg ? readUpdateSettings(cfg) : null } };
    } catch {
      // Only stable categories cross the CLI bridge, never private host error text.
      return { ok: false, error: action === "set" ? "save-failed" : changing ? "update-failed" : "unavailable" };
    } finally { unlock?.(); }
  }
  return { execute, read: readUpdateSettings, apply: applyUpdateSettings };
}
