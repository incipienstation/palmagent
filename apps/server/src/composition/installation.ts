import { TerminalStore } from "../modules/terminals/adapters/outbound/sqlite-terminal-store.js";
import { ExecutionStore } from "../modules/agents/adapters/outbound/execution-store.js";
import { RoutineHostStore } from "../modules/routines/adapters/outbound/routine-host-store.js";
import { createReleaseOperations } from "../modules/installation/adapters/outbound/execution-release.js";
import { createInstaller } from "../modules/installation/adapters/outbound/install.js";
import { doctor as checkInstallation } from "../modules/installation/adapters/outbound/checks.js";
export type { Flags } from "../modules/installation/adapters/outbound/install.js";

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
  loadInstalledConfig, postUpgradeArgs, gatherConfig, install, setup, update,
  prepareIndependentRuntime, provisionIndependentRuntime, uninstall, passkey, runDoctor,
} = createInstaller({ ...releases, doctor: cfg => checkInstallation(cfg, releases.verifyActiveExecutionCompatibility) });
