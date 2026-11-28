import type { CreateElicitationRequest, CreateElicitationResponse } from "@agentclientprotocol/sdk";
import type { AnswerRequest, AskQuestion, QuestionRequest } from "@palmagent/shared";
import { z } from "zod";

// The bridge marks Codex questions and their companion note fields. Other ACP
// forms (including tool authentication) cannot use the task's public transcript.
const schema = z.object({ requestedSchema: z.object({ properties: z.record(z.string(), z.object({
  type: z.literal("string"), title: z.string(), description: z.string().optional(),
  oneOf: z.array(z.object({ const: z.string(), description: z.string().optional() })).optional(),
  _meta: z.object({ codex: z.object({ isSecret: z.boolean(), role: z.string().optional(), questionId: z.string().optional() }) }),
})) }) });

export class CodexAcpQuestions {
  private pending?: { id: string; answer: (response: AnswerRequest) => boolean };

  constructor(private show: (question: QuestionRequest) => void, private dismissed: (id: string) => void) {}

  request(id: string, params: CreateElicitationRequest, signal: AbortSignal): Promise<CreateElicitationResponse> {
    const parsed = schema.safeParse(params);
    if (!parsed.success || this.pending || signal.aborted) return Promise.resolve({ action: "decline" });
    const questions: AskQuestion[] = [];
    const notes = new Map<string, string>();
    for (const [key, field] of Object.entries(parsed.data.requestedSchema.properties)) {
      const meta = field._meta.codex;
      if (meta.isSecret) return Promise.resolve({ action: "decline" });
      if (meta.role === "user_note" && meta.questionId) notes.set(meta.questionId, key);
      else questions.push({ id: key, question: field.title, header: field.description, options:
        (field.oneOf ?? []).map(option => ({ label: option.const, description: option.description })) });
    }
    if (!questions.length) return Promise.resolve({ action: "decline" });
    return new Promise(resolve => {
      const finish = (value: CreateElicitationResponse) => {
        signal.removeEventListener("abort", cancel);
        this.pending = undefined;
        resolve(value);
      };
      const cancel = () => { finish({ action: "cancel" }); this.dismissed(id); };
      signal.addEventListener("abort", cancel, { once: true });
      this.pending = { id, answer: req => {
        const content: Record<string, string | string[]> = Object.create(null);
        for (const q of questions) {
          const key = q.id!;
          const matches = req.answers.filter(a => a.questionId ? a.questionId === key : a.question === q.question);
          const answer = matches[0];
          if (matches.length > 1 || (answer && !answer.questionId && questions.filter(x => x.question === q.question).length > 1)) return false;
          const note = [answer?.notes, req.response].filter(Boolean).join("\n");
          const noteKey = notes.get(key);
          if (noteKey && note) content[noteKey] = note;
          const values = [...(answer?.selected ?? []), ...(!noteKey && note ? [note] : [])];
          if (values.length) content[key] = values.length === 1 ? values[0] : values;
        }
        finish({ action: "accept", content });
        return true;
      } };
      this.show({ requestId: id, questions });
    });
  }

  answer(req: AnswerRequest) {
    return this.pending?.id === req.requestId && this.pending.answer(req);
  }
}
