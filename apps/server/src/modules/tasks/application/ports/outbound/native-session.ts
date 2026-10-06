import type { AgentEvent, AgentKind, TaskState } from "@palmagent/shared";
import type { DispatchSessionRequest } from "@palmagent/shared";

export interface NativeSessionDispatch {
  cwd: string;
  home: string;
  transcript: string;
  identity: string;
}

export interface NativeSessionOperations {
  readonly emptyTranscriptHash: string;
  home(agent: AgentKind): string;
  realpath(path: string): string;
  processIdentity(pid: number): string | undefined;
  checkpoint(task: TaskState): TaskState["sessionControl"];
  resumeCommand(task: TaskState): string;
  resolveDispatch(request: DispatchSessionRequest, expectedHome: string): NativeSessionDispatch;
  synchronize(task: TaskState, options?: { preview?: boolean }): { control: NonNullable<TaskState["sessionControl"]>; events: AgentEvent[] };
}
