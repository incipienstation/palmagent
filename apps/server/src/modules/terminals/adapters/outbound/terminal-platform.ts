import { linuxShell, linuxSupervisor, ptyDriver, unixTransport } from "./linux.js";
import type { LocalTransport, ShellResolver, TerminalDriver, TerminalSupervisor } from "../../application/ports/outbound/terminal-platform.js";

import type { TerminalPlatform } from "../../application/ports/inbound/terminal-runtime.js";
import { daemonTerminalSupervisor } from "./daemon-supervisor.js";
export type { TerminalPlatform } from "../../application/ports/inbound/terminal-runtime.js";
/** Keep OS selection out of services, wire contracts, and clients. */
export function terminalPlatform(installed: boolean, platform: NodeJS.Platform = process.platform, daemonData = process.env.PALMAGENT_DAEMON_DATA): TerminalPlatform {
  if (platform === "linux") return { supported: true, driver: ptyDriver, shell: linuxShell, transport: unixTransport,
    supervisor: installed && daemonData ? daemonTerminalSupervisor(daemonData) : linuxSupervisor(installed) };
  const unsupported = (): never => { throw new Error("Shell access is not yet supported on this platform"); };
  return {
    supported: false, driver: { spawn: unsupported }, shell: { resolve: unsupported },
    transport: { connect: async () => unsupported(), listen: async () => unsupported() },
    supervisor: {
      capabilities: { available: false, persistent: false, reason: "Shell access is not yet supported on this platform." },
      launch: async () => unsupported(), terminate: async () => unsupported(), alive: async () => unsupported(),
    },
  };
}
