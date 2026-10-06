import type { TerminalSession } from "@palmagent/shared/terminals";

export interface TerminalRecord extends TerminalSession {
  diagnostic?: boolean; diagnosticCleanupFailed?: boolean;
  requestId: string; release: string; node: string; directory: string;
  cols: number; rows: number; pid?: number; identity?: string;
}
export const active = (record: TerminalRecord) => ["starting", "running", "closing"].includes(record.state);
export const publicTerminal = ({ id, taskId, repoId, title, initialCwd, state, createdAt, exitCode, protocol, startError, startErrorCode }: TerminalRecord): TerminalSession =>
  ({ id, taskId, repoId, title, initialCwd, state, createdAt, exitCode, protocol, startError, startErrorCode });
