import type { TerminalCapabilities, TerminalSession } from "@palmagent/shared/terminals";
import type { TerminalRecord } from "../../../domain/terminal.js";
import type { CreateTerminalRequest } from "@palmagent/shared/terminals";

/** Operations accepted by the terminals module. */
export interface TerminalUseCases {
  capabilities(): TerminalCapabilities;
  start(): void;
  list(query?: { taskId?: string; repoId?: string; }): TerminalSession[];
  get(id: string): TerminalRecord;
  getPublic(id: string): TerminalSession;
  create(input: CreateTerminalRequest): Promise<TerminalSession>;
  rename(id: string, title: string): TerminalSession;
  terminate(id: string): Promise<TerminalSession>;
  reconcile(): Promise<void>;
  close(): Promise<void>;
}
