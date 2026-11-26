import type { AskQuestion, AnswerRequest, InputAttachment } from "@palmagent/shared";
import { sampledAgentInput } from "@palmagent/shared";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk/core";
import type { StartArgs } from "../../domain/execution.js";

type ClaudeUserMessage = {
  type: "user";
  message: {
    role: "user";
    content: Array<
      | { type: "image"; source: { type: "base64"; media_type: InputAttachment["mediaType"]; data: string } }
      | { type: "text"; text: string }
    >;
  };
};

export function buildClaudeUserMessage(text: string, images: readonly InputAttachment[] = []): ClaudeUserMessage {
  const input = sampledAgentInput(text, images);
  const content: ClaudeUserMessage["message"]["content"] = input.images.map((image) => ({
    type: "image",
    source: { type: "base64", media_type: image.mediaType, data: image.data },
  }));
  content.push({ type: "text", text: input.text });
  return { type: "user", message: { role: "user", content } };
}

export function claudeSkillPrompt(text: string, skills?: StartArgs["skills"]): string {
  return skills?.length ? `/${skills[0].name} ${text}` : text;
}

export function claudeAnswer(questions: AskQuestion[], req: AnswerRequest): PermissionResult {
  const byQuestion = new Map(questions.map((q) => [q.question, q]));
  const answers: Record<string, string | string[]> = {};
  const annotations: Record<string, { notes: string }> = {};
  for (const a of req.answers ?? []) {
    if (a.selected?.length) {
      answers[a.question] = byQuestion.get(a.question)?.multiSelect ? a.selected : a.selected[0];
    }
    if (a.notes?.trim()) annotations[a.question] = { notes: a.notes.trim() };
  }
  const response = req.response?.trim();
  const picked = Object.keys(answers).length > 0 || Object.keys(annotations).length > 0 || !!response;
  if (!picked) return { behavior: "deny", message: "User declined to answer." };
  const updatedInput: Record<string, unknown> = { questions, answers };
  if (Object.keys(annotations).length) updatedInput.annotations = annotations;
  if (response) updatedInput.response = response;
  return { behavior: "allow", updatedInput };
}
