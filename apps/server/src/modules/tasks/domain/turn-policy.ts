import type { AgentEvent } from "@palmagent/shared";

/** Terminal evidence is rebuilt from replay, even when history effects are skipped. */
export interface TurnEvidence {
  failureMessage?: string;
  sawResult: boolean;
  lastResultError: boolean;
  errored: boolean;
  abnormalExit?: boolean;
}

export function observeTurn(evidence: TurnEvidence, event: Pick<AgentEvent, "kind" | "payload">): void {
  if (event.kind === "error") {
    evidence.errored = true;
    const message = (event.payload as { message?: unknown } | null)?.message;
    if (typeof message === "string") evidence.failureMessage = message;
  }
  if (event.kind === "result") {
    evidence.sawResult = true;
    evidence.lastResultError = !!(event.payload as { is_error?: boolean })?.is_error;
  }
  if (event.kind === "status") {
    const status = event.payload as { subtype?: string; code?: number | null };
    if (status.subtype === "process_exit") evidence.abnormalExit = status.code !== 0;
    if (status.subtype === "reattach_failed") evidence.abnormalExit = true;
  }
}

export function turnFailed(evidence: TurnEvidence, compacting: boolean, steerRestart: boolean): boolean {
  // The last terminal result supersedes transient errors and interrupted results.
  // A lost process is never success; an intentional settings restart may chain.
  // Compaction always requires a terminal result, including during a restart.
  return compacting && !evidence.sawResult || !steerRestart &&
    !!(evidence.abnormalExit || (evidence.sawResult ? evidence.lastResultError : evidence.errored));
}
