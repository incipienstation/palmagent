import type { TerminalCapabilities } from "@palmagent/shared/terminals";
import type { TerminalRecord } from "./store.js";

export interface TerminalProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  terminate(): void;
  pause(): void;
  resume(): void;
  onOutput(callback: (data: string) => void): () => void;
  onExit(callback: (code: number) => void): () => void;
}
export interface ShellProfile { executable: string; args: string[]; env: Record<string, string> }
export interface TerminalDriver {
  spawn(profile: ShellProfile, cwd: string, cols: number, rows: number): TerminalProcess;
}
export interface TerminalSupervisor {
  capabilities: TerminalCapabilities;
  inspect?(): Promise<void>;
  launch(record: TerminalRecord): Promise<void>;
  terminate(record: TerminalRecord): Promise<void>;
  alive(record: TerminalRecord): Promise<boolean>;
}
export interface ShellResolver { resolve(): ShellProfile; diagnosticCommand?(marker: string): string }
export interface LocalChannel {
  send(value: unknown): boolean;
  close(): void;
  onMessage(callback: (value: unknown) => void): void;
  onClose(callback: () => void): void;
}
export interface LocalTransport {
  connect(directory: string, id: string): Promise<LocalChannel>;
  listen(directory: string, id: string, accept: (channel: LocalChannel) => void): Promise<() => void>;
}
