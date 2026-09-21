import type { PendingMessage } from "@palmagent/shared";
import { UserBubble } from "./EventLog";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";

// A delivery receipt is not a waiting turn, even though both share server storage.
export function isWaitingMessage(message: PendingMessage) {
  return message.mode === "queue" && message.status === "queued";
}

export function MessageDelivery({ messages, paused, disabled, resumeDisabled, onDelete, onResume }: {
  messages: PendingMessage[]; paused: boolean; disabled: boolean; resumeDisabled: boolean;
  onDelete: (message: PendingMessage) => void; onResume: () => void;
}) {
  if (!messages.length) return null;
  return <section aria-label="Message delivery status" className="flex max-h-[min(16rem,30dvh)] flex-col gap-2 overflow-y-auto">
    {messages.map(message => {
      const imageCount = message.attachments?.length ?? message.images?.length ?? 0;
      const uncertain = message.status === "unknown";
      const rejected = message.status === "rejected";
      const waiting = message.status === "queued" && paused;
      const label = uncertain ? "Delivery unconfirmed" : rejected ? "Not sent" : waiting ? "Send paused" : "Sending…";
      return <div key={message.id} role="status" aria-label="Pending message">
        <UserBubble text={message.text} skills={message.skills}
          meta={`${label}${imageCount ? ` · ${imageCount} image(s)` : ""}`} />
        {(uncertain || rejected) && <Alert variant={uncertain ? "warning" : "destructive"}>
          <p>{message.error ?? (uncertain ? "Delivery could not be confirmed." : "The agent could not accept this message.")}</p>
          {uncertain && <p>Check the conversation before sending again. Dismissing this notice does not undo delivery.</p>}
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onDelete(message)}>Dismiss delivery notice</Button>
        </Alert>}
        {waiting && <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onDelete(message)}>Cancel send</Button>
          <Button variant="ghost" size="sm" disabled={disabled || resumeDisabled} onClick={onResume}>Resume delivery</Button>
        </div>}
      </div>;
    })}
  </section>;
}
