import type { Context } from "hono";
import { ApplicationError } from "../../../../kernel/errors.js";
import type { AdmissionCommand, AdmissionInbox, AdmissionStatus } from "../../application/ports/outbound/admission-inbox.js";

export interface UpdateAdmission {
  inbox: Pick<AdmissionInbox, "receive" | "status">;
  deferring(): boolean;
}

export function admitDuringUpdate(c: Context, admission: UpdateAdmission | undefined, command: AdmissionCommand) {
  if (!admission || c.req.header("prefer") !== "respond-async") return;
  const result = admission.inbox.receive(command, admission.deferring());
  return pendingReceipt(c, result, command.kind === "create" ? command.input.clientRequestId : command.input.clientMessageId);
}

export function readAdmission(c: Context, admission: UpdateAdmission | undefined, scope: string, id: string) {
  const result = admission?.inbox.status(scope, id);
  if (!result) throw new ApplicationError("not_found", "Update receipt was not found.");
  return pendingReceipt(c, result, id);
}

function pendingReceipt(c: Context, result: AdmissionStatus | undefined, requestId?: string) {
  if (result?.state === "rejected") throw new ApplicationError(result.code, result.reason);
  if (result?.state === "pending") {
    c.header("Cache-Control", "no-store");
    c.header("Preference-Applied", "respond-async");
    c.header("Retry-After", "1");
    return c.json({ state: "accepted" as const,
      requestId }, 202);
  }
}
