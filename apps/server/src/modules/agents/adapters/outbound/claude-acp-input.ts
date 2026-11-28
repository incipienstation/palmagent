import type { CreateElicitationRequest, CreateElicitationResponse, RequestPermissionRequest,
  RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { AnswerRequest, AskQuestion } from "@palmagent/shared";
import { z } from "zod";
import type { PermissionRequest, QuestionRequest } from "@palmagent/shared";

type PromptEvent = { kind: "question"; payload: QuestionRequest } | { kind: "approval_request"; payload: PermissionRequest };
const choices = z.array(z.object({ const: z.string(), description: z.string().optional() }));
const questionField = z.object({ title: z.string().optional(), description: z.string().optional() });
const form = z.object({ requestedSchema: z.object({ properties: z.record(z.string(), z.discriminatedUnion("type", [
  questionField.extend({ type: z.literal("string"), oneOf: choices.optional() }),
  questionField.extend({ type: z.literal("array"), items: z.object({ anyOf: choices }) }),
])) }) });

export class ClaudeAcpInput {
  private approvals = new Map<string, (decision: string) => void>();
  private questions = new Map<string, (answer: AnswerRequest) => void>();

  constructor(private emit: (event: PromptEvent) => void) {}

  permission(id: string, params: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
    // Tasks exposes one approval button. A second concurrent request cannot
    // replace the displayed one and still receive the correct decision.
    if (this.approvals.size) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    return new Promise(resolve => {
      const finish = (optionId?: string) => {
        this.approvals.delete(id);
        signal.removeEventListener("abort", cancel);
        resolve({ outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } });
      };
      const cancel = () => finish();
      if (signal.aborted) return cancel();
      signal.addEventListener("abort", cancel, { once: true });
      this.approvals.set(id, decision => finish(params.options.find(option =>
        option.kind === (decision === "approve" ? "allow_once" : "reject_once"))?.optionId));
      this.emit({ kind: "approval_request", payload: { requestId: id, tool: params.toolCall.title ?? "Tool",
        input: params.toolCall.rawInput } });
    });
  }

  question(id: string, params: CreateElicitationRequest, signal: AbortSignal): Promise<CreateElicitationResponse> {
    // The Claude adapter encodes AskUserQuestion as indexed enum fields, each
    // paired with an optional free-text field. Decline other forms we cannot render.
    const parsed = form.safeParse(params);
    if (!parsed.success) return Promise.resolve({ action: "decline" });
    const questions: AskQuestion[] = [];
    for (const [key, field] of Object.entries(parsed.data.requestedSchema.properties)) {
      if (/^question_\d+_custom$/.test(key) && field.type === "string") continue;
      const choices = field.type === "string" ? field.oneOf : field.items.anyOf;
      if (!choices || key !== `question_${questions.length}`) return Promise.resolve({ action: "decline" });
      questions.push({ id: key, question: field.description || params.message, header: field.title,
        multiSelect: field.type === "array", options: choices.map(option => ({ label: option.const, description: option.description ?? undefined })) });
    }
    if (!questions.length || signal.aborted || this.questions.size) return Promise.resolve({ action: "cancel" });
    return new Promise(resolve => {
      const finish = (result: CreateElicitationResponse) => {
        this.questions.delete(id);
        signal.removeEventListener("abort", cancel);
        resolve(result);
      };
      const cancel = () => finish({ action: "cancel" });
      signal.addEventListener("abort", cancel, { once: true });
      this.questions.set(id, answer => {
        const content: Record<string, string | string[]> = {};
        for (const [index, question] of questions.entries()) {
          const key = `question_${index}`;
          const value = answer.answers?.find(item => item.questionId ? item.questionId === key : item.question === question.question);
          if (value?.selected?.length) content[key] = question.multiSelect ? value.selected : value.selected[0];
          const notes = [value?.notes?.trim(), index === 0 && answer.response?.trim()].filter(Boolean).join("\n");
          if (notes) content[key + "_custom"] = notes;
        }
        finish(Object.keys(content).length ? { action: "accept", content } : { action: "decline" });
      });
      this.emit({ kind: "question", payload: { requestId: id, questions } });
    });
  }

  approve(decision: string) {
    const first = this.approvals.values().next().value;
    first?.(decision);
    return !!first;
  }

  answer(answer: AnswerRequest) {
    const pending = this.questions.get(answer.requestId);
    pending?.(answer);
    return !!pending;
  }
}
