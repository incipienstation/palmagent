import type { TerminalRecord, TerminalPlatform } from "../../../../terminals/api.js";
import type { DiagnosticSessions } from "./diagnostic-sessions.js";
export interface DiagnosticRegistry {
  readonly directory: string;
  reserve(input: Omit<TerminalRecord, "id" | "createdAt" | "state" | "protocol">): { record: TerminalRecord; created: boolean };
  get(id: string): TerminalRecord | undefined;
  update(id: string, change: Partial<TerminalRecord>): TerminalRecord;
  removeDiagnostic(id: string): void;
  close(): void;
}
export interface TerminalDiagnosticsHost {
  sessions: DiagnosticSessions;
  platform(daemonData?: string): TerminalPlatform;
  registry(directory: string): DiagnosticRegistry;
}
