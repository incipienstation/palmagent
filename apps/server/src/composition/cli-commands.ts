import { createSpaceSettings } from "../modules/spaces/composition.js";
import { terminalPlatform } from "../modules/terminals/adapters/outbound/terminal-platform.js";
import { parseRepoRoots } from "../modules/spaces/adapters/outbound/settings-store.js";
import { loadConfig, resolveDataDir } from "../modules/installation/adapters/outbound/config.js";
import { sessionCommand as session } from "../modules/tasks/adapters/inbound/cli.js";
import { routineCommand as routine } from "../modules/routines/adapters/inbound/cli.js";
import { settingsCommand as settings } from "../modules/spaces/adapters/inbound/cli.js";
import { terminalCommand as terminal } from "../modules/terminals/adapters/inbound/cli.js";
import { connectionCommand as connection } from "../modules/installation/adapters/inbound/connection-cli.js";
import { connectionInfo } from "../modules/installation/adapters/outbound/connection.js";
import { createConnectionDiagnostics } from "../modules/installation/adapters/outbound/connection-diagnostics.js";
import { diagnosticSessions } from "./diagnostic-sessions.js";
const environment = { loadConfig, resolveDataDir };
export const connectionCommand = (args: string[]) => connection(args, {
  connection: dataDir => connectionInfo(loadConfig({ dataDir, requireInstalled: true })),
  diagnose: dataDir => createConnectionDiagnostics(diagnosticSessions)(loadConfig({ dataDir, requireInstalled: true })),
});
export const sessionCommand = (args: string[]) => session(args, environment);
export const routineCommand = (args: string[]) => routine(args, environment);
export const settingsCommand = (args: string[]) => settings(args, resolveDataDir, directory => createSpaceSettings(directory, parseRepoRoots(process.env.REPO_ROOTS ?? "")));
export const terminalCommand = (args: string[]) => terminal(args, { ...environment, platform: terminalPlatform,
  diagnose: async dataDir => (await import("./terminal-diagnostics.js")).diagnoseTerminal(loadConfig({ dataDir, requireInstalled: true })),
});
