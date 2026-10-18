import type { AgentKind, AnswerRequest, InputAttachment, PermissionRequest, QuestionRequest, SkillSelection } from "@palmagent/shared";
import type { RawEvent } from "../../../domain/execution.js";

export interface SharedSessionSnapshot {
  historyMode: "legacy" | "paginated";
  status: "idle" | "running";
  turnId?: string;
  model?: string;
  effort?: string;
  question?: QuestionRequest;
  approval?: PermissionRequest;
}
export interface SharedSessionEvent {
  /** Stable provider identity; reconnects may repeat it. Assistant text is a cumulative snapshot. */
  key: string;
  event: RawEvent;
}
export interface SharedSessionConnection {
  snapshot(): Promise<SharedSessionSnapshot>;
  history(): Promise<SharedSessionEvent[]>;
  send(text: string, images: InputAttachment[] | undefined, messageId: string, skills?: SkillSelection[]): Promise<"delivered" | "rejected" | "unknown">;
  interrupt(): Promise<boolean>;
  approve(requestId: string, decision: string): Promise<boolean>;
  answer(request: AnswerRequest): Promise<boolean>;
  close(): void;
}
export interface SharedSessionConnector {
  connect(request: { taskId: string; agent: AgentKind; sessionId: string; cwd: string; home: string; socket?: string },
    changed: () => void): Promise<SharedSessionConnection | undefined>;
}
