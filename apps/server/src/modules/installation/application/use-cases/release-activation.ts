import type { StandaloneSelection } from "@palmagent/shared/standalone";
import type { InstallConfig } from "../../domain/installation.js";
import type { ActivationReceipt } from "../../domain/installation-observations.js";
import { compatiblePlugin } from "../../domain/release-policy.js";
import type { InstallationDependencies } from "../ports/outbound/installation.js";
import type { InstallationOptions, InstallationUseCases } from "../ports/inbound/installation-use-cases.js";
import { independentActivationBlock } from "./installation-activation.js";

export function releaseActivation({ configuration, state, runtime, releases }: InstallationDependencies,
  provision: InstallationUseCases["provisionRuntime"], cfg: InstallConfig, version: string, options: InstallationOptions,
  selection?: StandaloneSelection, resume?: ActivationReceipt) {
  let candidate: InstallConfig;
  let identity: ReturnType<typeof releases.identity>;
  let compatible: ReturnType<typeof runtime.handoffCompatibility>;
  let autoUpdate: boolean;
  let closeGateway: (() => Promise<void>) | undefined;
  let endWindow: (() => void) | undefined;
  const intent = (phase: "prepared" | "configured" | "verified"): ActivationReceipt => ({
    previous: cfg, target: candidate, status: "applying",
    ...(closeGateway ? { verification: identity, handoff: { phase, previousVersion: releases.installedVersion(cfg.pkgDir),
      targetVersion: version, manifestSha256: selection?.manifestSha256 ?? resume?.handoff?.manifestSha256,
      pluginManifests: options.pluginManifests, requestId: options.request?.id ?? resume?.handoff?.requestId } } : {}),
  });
  return {
    stage() {
      if (!cfg.supervisor && !runtime.canManageServices()) throw new Error("Updates require non-interactive service-management access");
      candidate = resume?.target ?? releases.stage(cfg, version, selection);
      identity = releases.identity(candidate.pkgDir!);
      if (resume && (identity.version !== resume.verification?.version || identity.sourceCommit !== resume.verification.sourceCommit ||
        Object.entries(resume.verification.files).some(([path, digest]) => identity.files[path] !== digest)))
        throw new Error("Staged release identity changed after the interrupted activation");
      releases.verifyCli(candidate, version, true);
      compatible = runtime.handoffCompatibility(cfg, candidate);
      return compatible;
    },
    async openGateway() { closeGateway = await runtime.openUpdateGateway(cfg, candidate); },
    async admission() {
      endWindow = state.beginMaintenance(cfg, Boolean(closeGateway));
      return cfg.executionNode ? await independentActivationBlock(runtime, cfg, Boolean(closeGateway))
        : await runtime.legacyIdle(cfg) ? undefined : "tasks-active";
    },
    preferences() {
      configuration.initializePreferences(cfg.dataDir);
      const settings = configuration.preferences(cfg.dataDir);
      autoUpdate = Boolean(settings.autoUpdate);
      return !(options.automatic && !autoUpdate) && (!(options.automatic || options.request) || settings.channel === candidate.releaseChannel);
    },
    prepareIntent() { runtime.verifyCompatibility(candidate); state.writeActivation(cfg, intent("prepared")); },
    needsSwitch() { return configuration.load(cfg.dataDir).pkgDir !== candidate.pkgDir || !runtime.healthy(candidate, version); },
    configure() {
      provision(candidate, options); configuration.save(candidate);
      if (closeGateway) state.writeActivation(cfg, intent("configured"));
    },
    restart: () => runtime.restartWeb(candidate),
    async verify() {
      if (!await runtime.waitHealthy(candidate, version)) throw new Error("Candidate application health check failed");
      await releases.verifyApplication(identity, candidate);
      if (autoUpdate) await runtime.configureAutoUpdate(candidate);
      if (releases.readPlugins(options.pluginManifests).some(p => !compatiblePlugin(version, p.version)))
        throw new Error("An operator plugin changed during activation");
    },
    commit() {
      configuration.persistChannel(candidate, options.channel !== undefined);
      state.writeActivation(cfg, { ...intent("verified"), status: "succeeded", verification: identity });
    },
    async restore() {
      provision(cfg, options); configuration.save(cfg); await runtime.restartWeb(cfg);
      const restored = await runtime.waitHealthy(cfg, releases.installedVersion(cfg.pkgDir));
      if (restored && configuration.preferences(cfg.dataDir).autoUpdate) await runtime.configureAutoUpdate(cfg);
      return restored;
    },
    recoveryReceipt(restored: boolean) {
      state.writeActivation(cfg, { previous: cfg, target: candidate, status: restored ? "restored" : "recovery-required" });
    },
    async close() { try { endWindow?.(); } finally { await closeGateway?.(); } },
  };
}
