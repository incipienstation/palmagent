import type { SideChatSend, SideChatSnapshot } from "@palmagent/shared";

export interface SideChatTarget { taskId: string; sessionId: string; home: string; cwd: string }
export interface SideChatOperations {
  get(taskId: string): SideChatSnapshot | null;
  open(target: SideChatTarget): Promise<SideChatSnapshot>;
  send(taskId: string, message: SideChatSend): Promise<SideChatSnapshot>;
  stop(taskId: string, sessionId: string): Promise<SideChatSnapshot>;
  end(taskId: string, sessionId: string): SideChatSnapshot;
  close(): void;
}
