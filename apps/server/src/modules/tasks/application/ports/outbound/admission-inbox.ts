import type { CreateTaskRequest, SubmitMessage } from "@palmagent/shared";
import type { ApplicationErrorCode } from "../../../../../kernel/errors.js";

export type AdmissionCommand = { kind: "create"; input: CreateTaskRequest } | { kind: "message"; taskId: string; input: SubmitMessage };
export type AdmissionStatus = { state: "pending" | "applied" } | { state: "rejected"; code: ApplicationErrorCode; reason: string };
export interface AdmissionInbox {
  /** Returns undefined when a new request can go directly to the active owner. */
  receive(command: AdmissionCommand, defer: boolean): AdmissionStatus | undefined;
  status(scope: string, id: string): AdmissionStatus | undefined;
  hasPending(): boolean;
  assertOwner(): void;
  next(): { sequence: number; command: AdmissionCommand } | undefined;
  finish(sequence: number, status: AdmissionStatus): void;
}
