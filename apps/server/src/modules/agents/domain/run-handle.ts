import type { InputAttachment, SkillSelection, AnswerRequest } from "@palmagent/shared";

/** A live use-case handle for an executing agent turn. */
export interface RunHandle {
  send?: (text: string, images: InputAttachment[] | undefined, messageId: string, skills?: SkillSelection[]) => Promise<"delivered" | "rejected" | "unknown">;
  steer: (text: string, images?: InputAttachment[]) => boolean;
  interrupt: () => boolean;
  approve: (decision: string, scope?: string) => boolean;
  answer: (req: AnswerRequest) => boolean | Promise<boolean>;
  cancel: () => void;
  done: Promise<void>;
}
