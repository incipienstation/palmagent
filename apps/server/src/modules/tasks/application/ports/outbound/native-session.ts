import type { AgentEvent, AgentKind, TaskState } from "@palmagent/shared";
import type { DispatchSessionRequest } from "@palmagent/shared";

export interface NativeSessionDispatch {
  cwd: string;
  home: string;
  transcript: string;
  identity: string;
}

export interface SessionTitleTarget { sessionId: string; cwd: string }
export interface SessionLabel { title: string | null; firstPrompt?: string }

export interface NativeSessionOperations {
  readonly emptyTranscriptHash: string;
  readTitles(agent: AgentKind, home: string, targets: SessionTitleTarget[], signal?: AbortSignal): Promise<Map<string, SessionLabel>>;
  home(agent: AgentKind): string;
  realpath(path: string): string;
  processIdentity(pid: number): string | undefined;
  sharedSocket(task: TaskState): string | undefined;
  checkpoint(task: TaskState): TaskState["sessionControl"];
  resumeCommand(task: TaskState): string;
  resolveDispatch(request: DispatchSessionRequest, expectedHome: string): NativeSessionDispatch;
  synchronize(task: TaskState, options?: { preview?: boolean }): { control: NonNullable<TaskState["sessionControl"]>; events: AgentEvent[] };
}
