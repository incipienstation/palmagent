import type { PendingMessage } from "@palmagent/shared";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";

// A delivery receipt is not a waiting turn, even though both share server storage.
export function isWaitingMessage(message: PendingMessage) {
  return message.mode === "queue" && message.status === "queued";
}

export type DeliveryControls = {
  messages: PendingMessage[]; paused: boolean; disabled: boolean; resumeDisabled: boolean;
  onDelete: (message: PendingMessage) => void; onResume: () => void;
  recovery?: { retry: () => void; check: () => void };
  pendingHint?: string;
};

// Normal delivery uses the transcript's Working label. Only actionable states
// need extra UI, beside the message they describe rather than in the composer.
export function MessageDelivery({ message, paused, disabled, resumeDisabled, onDelete, onResume, recovery, pendingHint }: Omit<DeliveryControls, "messages"> & {
  message: PendingMessage;
}) {
  const uncertain = message.status === "unknown";
  const rejected = message.status === "rejected";
  const waiting = message.status === "queued" && paused;
  if (uncertain || rejected) return <Alert className="mb-3 font-sans" variant={uncertain ? "warning" : "destructive"}>
    <p className="font-semibold">{uncertain ? "Delivery unconfirmed" : "Not sent"}</p>
    <p>{message.error ?? (uncertain ? "Delivery could not be confirmed." : "The agent could not accept this message.")}</p>
    {uncertain && !recovery && <p>Check the conversation before sending again. Dismissing this notice does not undo delivery.</p>}
    {recovery ? <div className="flex flex-wrap gap-2">
      {uncertain && <Button variant="ghost" disabled={disabled} onClick={recovery.check}>Check status</Button>}
      <Button variant="secondary" disabled={disabled} onClick={recovery.retry}>Retry</Button>
      {!uncertain && <Button variant="ghost" disabled={disabled} onClick={() => onDelete(message)}>Edit message</Button>}
    </div> : <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onDelete(message)}>Dismiss delivery notice</Button>}
  </Alert>;
  if (waiting) return <div className="mb-3 flex flex-wrap items-center justify-end gap-2 font-sans">
    <span className="text-sm text-muted-foreground">Send paused</span>
    <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onDelete(message)}>Cancel send</Button>
    <Button variant="ghost" size="sm" disabled={disabled || resumeDisabled} onClick={onResume}>Resume delivery</Button>
  </div>;
  return message.status === "sending" && pendingHint
    ? <p role="status" className="mb-3 font-sans text-sm text-muted-foreground">{pendingHint}</p> : null;
}
