export type { EventRow } from "../../../kernel/events.js";
import type { Attachment, MessageQueue, PendingMessage } from "@palmagent/shared";

/** Persistence and application records shared across use cases and adapters. */
export interface AttachmentRecord extends Attachment {
  taskId: string;
  digest: string;
  unusedSince: number | null;
  expiredAt: number | null;
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
