import { linuxShell, linuxSupervisor, ptyDriver, unixTransport } from "./linux.js";
import type { LocalTransport, ShellResolver, TerminalDriver, TerminalSupervisor } from "./platform.js";

export interface TerminalPlatform {
  driver: TerminalDriver;
  shell: ShellResolver;
  transport: LocalTransport;
  supervisor: TerminalSupervisor;
}
/** Keep OS selection out of services, wire contracts, and clients. */
export function terminalPlatform(installed: boolean, platform: NodeJS.Platform = process.platform): TerminalPlatform {
  if (platform === "linux") return { driver: ptyDriver, shell: linuxShell, transport: unixTransport, supervisor: linuxSupervisor(installed) };
  const unsupported = (): never => { throw new Error("Shell access is not yet supported on this platform"); };
  return {
    driver: { spawn: unsupported }, shell: { resolve: unsupported },
    transport: { connect: async () => unsupported(), listen: async () => unsupported() },
    supervisor: {
      capabilities: { available: false, persistent: false, reason: "Shell access is not yet supported on this platform." },
      launch: async () => unsupported(), terminate: async () => unsupported(), alive: async () => unsupported(),
    },
  };
}
