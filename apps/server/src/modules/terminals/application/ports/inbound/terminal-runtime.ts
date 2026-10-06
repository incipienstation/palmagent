import type { LocalTransport, ShellResolver, TerminalDriver, TerminalSupervisor } from "../outbound/terminal-platform.js";
export interface TerminalPlatform {
  supported: boolean;
  driver: TerminalDriver;
  shell: ShellResolver;
  transport: LocalTransport;
  supervisor: TerminalSupervisor;
}
