import { createTerminalDiagnostics } from "../modules/installation/adapters/outbound/terminal-diagnostics.js";
import { TerminalStore } from "../modules/terminals/adapters/outbound/sqlite-terminal-store.js";
import { terminalPlatform } from "../modules/terminals/adapters/outbound/terminal-platform.js";
import { verifyActiveExecutionCompatibility } from "./installation.js";
export { probeTerminalConnection } from "../modules/installation/adapters/outbound/terminal-diagnostics.js";
export const diagnoseTerminal = createTerminalDiagnostics({ platform: () => terminalPlatform(true), registry: directory => new TerminalStore(directory) }, verifyActiveExecutionCompatibility);
