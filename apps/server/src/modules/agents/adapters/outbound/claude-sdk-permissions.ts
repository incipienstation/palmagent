import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk/core";
import type { AnswerRequest, AskQuestion, PermissionRequest, QuestionRequest } from "@palmagent/shared";
import { claudeAnswer } from "./claude-messages.js";

type Prompt = { kind: "question"; payload: QuestionRequest } | { kind: "approval_request"; payload: PermissionRequest };

export class ClaudeSdkPermissions {
  private pending = new Map<string, {
    input: Record<string, unknown>;
    questions?: AskQuestion[];
    resolve: (decision: PermissionResult) => void;
  }>();

  constructor(private readonly emit: (prompt: Prompt) => void) {}

  readonly request: CanUseTool = (tool, input, { requestId, signal, decisionReason }) => {
    const denied = { behavior: "deny", message: "Permission request cancelled." } as const;
    if (signal.aborted) return Promise.resolve(denied);
    return new Promise(resolve => {
      const cancel = () => finish(denied);
      const finish = (decision: PermissionResult) => {
        this.pending.delete(requestId);
        signal.removeEventListener("abort", cancel);
        resolve(decision);
      };
      const questions = tool === "AskUserQuestion" && Array.isArray(input.questions) ? input.questions : undefined;
      this.pending.set(requestId, { input, questions, resolve: finish });
      signal.addEventListener("abort", cancel, { once: true });
      if (questions) this.emit({ kind: "question", payload: { requestId, questions } });
      else this.emit({ kind: "approval_request", payload: { requestId, tool, input, reason: decisionReason } });
    });
  };

  approve(decision: string) {
    for (const request of this.pending.values()) {
      if (request.questions) continue;
      request.resolve(decision === "approve" ? { behavior: "allow", updatedInput: request.input } :
        { behavior: "deny", message: "Denied by the user." });
      return true;
    }
    return false;
  }

  answer(answer: AnswerRequest) {
    const request = this.pending.get(answer.requestId);
    if (!request?.questions) return false;
    request.resolve(claudeAnswer(request.questions, answer));
    return true;
  }

  close() {
    for (const request of this.pending.values()) request.resolve({ behavior: "deny", message: "Session closed." });
  }
}
