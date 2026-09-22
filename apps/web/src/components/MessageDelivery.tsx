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
};

// Normal delivery uses the transcript's Working label. Only actionable states
// need extra UI, beside the message they describe rather than in the composer.
export function MessageDelivery({ message, paused, disabled, resumeDisabled, onDelete, onResume }: Omit<DeliveryControls, "messages"> & {
  message: PendingMessage;
}) {
  const uncertain = message.status === "unknown";
  const rejected = message.status === "rejected";
  const waiting = message.status === "queued" && paused;
  if (uncertain || rejected) return <Alert className="mb-3 font-sans" variant={uncertain ? "warning" : "destructive"}>
    <p className="font-semibold">{uncertain ? "Delivery unconfirmed" : "Not sent"}</p>
    <p>{message.error ?? (uncertain ? "Delivery could not be confirmed." : "The agent could not accept this message.")}</p>
    {uncertain && <p>Check the conversation before sending again. Dismissing this notice does not undo delivery.</p>}
    <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onDelete(message)}>Dismiss delivery notice</Button>
  </Alert>;
  if (waiting) return <div className="mb-3 flex flex-wrap items-center justify-end gap-2 font-sans">
    <span className="text-sm text-muted-foreground">Send paused</span>
    <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onDelete(message)}>Cancel send</Button>
    <Button variant="ghost" size="sm" disabled={disabled || resumeDisabled} onClick={onResume}>Resume delivery</Button>
  </div>;
  return null;
}
