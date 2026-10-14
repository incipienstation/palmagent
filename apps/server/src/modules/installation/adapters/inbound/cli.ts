import type { UpdateRequest } from "@palmagent/shared/updates";
import type { InstallConfig } from "../../domain/installation.js";
import type { InstallationOptions, InstallationUseCases } from "../../application/ports/inbound/installation-use-cases.js";

export interface Flags {
  dryRun: boolean; nonInteractive: boolean; force: boolean; purge: boolean; pull: boolean;
  plan?: boolean; automatic?: boolean; request?: UpdateRequest;
  get(key: string): string | undefined;
  getAll?(key: string): string[];
}
export function installationOptions(flags: Flags): InstallationOptions {
  return { dryRun: flags.dryRun, interactive: !flags.nonInteractive, force: flags.force,
    purge: flags.purge, pull: flags.pull, plan: flags.plan, automatic: flags.automatic, request: flags.request,
    dataDir: flags.get("data-dir"), channel: flags.get("channel"), targetVersion: flags.get("to"),
    expectedVersion: flags.get("expected-version"),
    pluginManifests: flags.getAll?.("plugin-manifest") ?? (flags.get("plugin-manifest") ? [flags.get("plugin-manifest")!] : []),
    domain: flags.get("domain"), host: flags.get("host"), port: flags.get("port"), concurrency: flags.get("concurrency"),
    repoRoots: flags.get("repo-roots"), claudeConfigDir: flags.get("claude-config-dir"), pushSubject: flags.get("push-subject"),
  };
}
export function createInstallationCommands(service: InstallationUseCases) {
  const exitCode = (success: boolean) => success ? 0 : 1;
  return {
    install: async (flags: Flags) => exitCode(await service.install(installationOptions(flags))),
    setup: async (flags: Flags) => exitCode(await service.setup(installationOptions(flags))),
    update: async (flags: Flags) => exitCode(await service.update(installationOptions(flags))),
    uninstall: async (flags: Flags) => exitCode(await service.uninstall(installationOptions(flags))),
    prepareIndependentRuntime: (flags: Flags, packageDirectory: string, node: string) => exitCode(service.prepareRuntime(installationOptions(flags), packageDirectory, node)),
    provisionIndependentRuntime: (config: InstallConfig, flags: Flags) => service.provisionRuntime(config, installationOptions(flags)),
    passkey: async (flags: Flags, mint: (database: string) => Promise<{ token: string; expiresAt: number }>) => exitCode(await service.passkey(installationOptions(flags), mint)),
    runDoctor: async (flags: Flags) => exitCode(await service.doctor(installationOptions(flags))),
  };
}
