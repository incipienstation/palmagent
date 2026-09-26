import type { AgentEvent, AnswerRequest, Attachment, ImageAttachment, MessageQueue, PendingMessage, SkillSelection } from "@palmagent/shared";

/** Persistence and application records shared across use cases and adapters. */
export interface EventRow {
  id: number;
  seq: number;
  event: AgentEvent;
}

export interface AttachmentRecord extends Attachment {
  taskId: string;
  digest: string;
  unusedSince: number | null;
  expiredAt: number | null;
}

export interface StoredCredential {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  label?: string | null;
  createdAt: number;
  lastUsedAt?: number | null;
}

export interface StoredMessage extends PendingMessage {
  fingerprint: string;
  editToken?: string;
}

export interface MessageState extends Omit<MessageQueue, "messages"> {
  messages: StoredMessage[];
  protocol?: "interactive";
  initialMessageId?: string;
  runtimeStarted?: boolean;
}

/** A live use-case handle for an executing agent turn. */
export interface RunHandle {
  send?: (text: string, images: ImageAttachment[] | undefined, messageId: string, skills?: SkillSelection[]) => Promise<"delivered" | "rejected" | "unknown">;
  steer: (text: string, images?: ImageAttachment[]) => boolean;
  interrupt: () => boolean;
  approve: (decision: string, scope?: string) => boolean;
  answer: (req: AnswerRequest) => boolean | Promise<boolean>;
  cancel: () => void;
  done: Promise<void>;
}
