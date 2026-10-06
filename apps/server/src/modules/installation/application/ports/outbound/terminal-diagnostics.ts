import type { TerminalRecord, TerminalPlatform } from "../../../../terminals/api.js";
export interface DiagnosticRegistry {
  readonly directory: string;
  reserve(input: Omit<TerminalRecord, "id" | "createdAt" | "state" | "protocol">): { record: TerminalRecord; created: boolean };
  get(id: string): TerminalRecord | undefined;
  update(id: string, change: Partial<TerminalRecord>): TerminalRecord;
  removeDiagnostic(id: string): void;
  close(): void;
}
export interface TerminalDiagnosticsHost {
  platform(): TerminalPlatform;
  registry(directory: string): DiagnosticRegistry;
}
