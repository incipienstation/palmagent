import { TerminalStore } from "../modules/terminals/adapters/outbound/sqlite-terminal-store.js";
import { ExecutionStore } from "../modules/agents/adapters/outbound/execution-store.js";
import { RoutineHostStore } from "../modules/routines/adapters/outbound/routine-host-store.js";
import { createReleaseOperations } from "../modules/installation/adapters/outbound/execution-release.js";
import { createInstallationService } from "../modules/installation/application/use-cases/installation-service.js";
import { createInstallationCommands, type Flags } from "../modules/installation/adapters/inbound/cli.js";
import type { InstallationDiagnostics, RetainedReleaseOperations } from "../modules/installation/application/ports/outbound/installation.js";
import { installationConfiguration } from "../modules/installation/adapters/outbound/installation-configuration.js";
import { installationState } from "../modules/installation/adapters/outbound/installation-state.js";
import { createInstallationRuntime } from "../modules/installation/adapters/outbound/installation-runtime.js";
import { createInstallationReleases } from "../modules/installation/adapters/outbound/installation-releases.js";
import { installationFeedback } from "../modules/installation/adapters/outbound/installation-feedback.js";
import { applicationChecks } from "../modules/installation/adapters/outbound/application-verification.js";
import { doctor as checkInstallation } from "../modules/installation/adapters/outbound/checks.js";
export type { Flags } from "../modules/installation/adapters/inbound/cli.js";

const releases = createReleaseOperations({
  terminals: directory => new TerminalStore(directory), executions: directory => new ExecutionStore(directory),
  routines: directory => {
    const store = new RoutineHostStore(directory);
    return store.list().filter(record => !store.recorded(record.id)).map(record => ({ ...record, state: "running" }));
  },
});
export const doctor = (cfg: Parameters<typeof checkInstallation>[0]) => checkInstallation(cfg, releases.verifyActiveExecutionCompatibility);
export { preflight } from "../modules/installation/adapters/outbound/checks.js";
export const { stageRelease, verifyActiveExecutionCompatibility, assertExecutionsFinished } = releases;
export const {
  install, setup, update,
  prepareIndependentRuntime, provisionIndependentRuntime, uninstall, passkey, runDoctor,
} = createInstaller({ ...releases, doctor: cfg => checkInstallation(cfg, releases.verifyActiveExecutionCompatibility) });

export const loadInstalledConfig = (flags: Flags) => installationConfiguration.load(flags.get("data-dir"));

export function createInstaller(retained: RetainedReleaseOperations & Pick<InstallationDiagnostics, "doctor">) {
  const service = createInstallationService({
    configuration: installationConfiguration, state: installationState,
    runtime: createInstallationRuntime(retained), releases: createInstallationReleases(retained),
    feedback: installationFeedback, diagnostics: { doctor: retained.doctor, application: applicationChecks },
  });
  return createInstallationCommands(service);
}
