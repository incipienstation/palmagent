import type { TerminalRecord } from "../../../domain/terminal.js";
import type { TerminalStartError } from "@palmagent/shared/terminals";

export interface TerminalRegistry {
  readonly directory: string;
  list(): TerminalRecord[];
  get(id: string): TerminalRecord | undefined;
  reserve(input: Omit<TerminalRecord, "id" | "createdAt" | "state" | "protocol">): { record: TerminalRecord; created: boolean };
  update(id: string, change: Partial<TerminalRecord>): TerminalRecord;
  noteStartError(id: string, code: TerminalStartError, message: string): void;
  expireStartup(id: string): boolean;
  pendingCleanup(): { cwd: string; taskId: string }[];
  cleanup(cwd: string, taskId: string, remove: () => void): boolean;
  close(): void;
}
export interface TerminalFiles {
  resolveDirectory(path: string): string;
  writeLaunchDescriptor(directory: string, record: TerminalRecord): void;
}
