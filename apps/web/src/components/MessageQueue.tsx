import { useState } from "react";
import type { MessageQueue as Queue, PendingMessage } from "@palmagent/shared";
import { Button } from "./ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";
import { useLongPress } from "../hooks/useLongPress";
import { cn } from "../lib/utils";

function QueueItem({ message, index, disabled, onEdit, onSend, onDelete }: {
  message: PendingMessage; index: number; disabled: boolean;
  onEdit: () => void; onSend: () => void; onDelete: () => void;
}) {
  const [panel, setPanel] = useState<"detail" | "actions" | null>(null);
  const press = useLongPress(() => setPanel("actions"), () => setPanel("detail"), disabled);
  const editing = (message.editingUntil ?? 0) > Date.now();
  return <Popover open={!!panel} onOpenChange={open => { if (!open) setPanel(null); }}>
    <PopoverAnchor asChild>
      <Button type="button" variant="ghost" className={cn("h-auto min-h-11 w-full justify-start touch-pan-y select-none [-webkit-touch-callout:none]", press.pressing && "scale-[0.98]")}
        disabled={disabled} aria-label={`Queued message ${index + 1}: ${message.text}`} aria-haspopup="dialog" aria-expanded={!!panel} {...press.handlers}>
        <span className="shrink-0">{index + 1}.</span><span className="truncate">{message.text}</span>
        {message.images?.length ? <span className="shrink-0">· {message.images.length} image(s)</span> : null}
        <span className="ml-auto shrink-0">{editing ? "Editing" : message.status === "queued" ? "" : message.status}</span>
      </Button>
    </PopoverAnchor>
    <PopoverContent side="top" align="start" className="max-h-80 overflow-y-auto p-2" aria-label="Queued message">
      {panel === "detail" ? <p className="whitespace-pre-wrap break-words p-2">{message.text}</p> : <div className="flex flex-col gap-1">
        <Button variant="ghost" disabled={message.status !== "queued" || editing} onClick={() => { setPanel(null); onEdit(); }}>Edit prompt</Button>
        <Button variant="ghost" disabled={message.status !== "queued" || editing} onClick={() => { setPanel(null); onSend(); }}>Send now</Button>
        <Button variant="ghost" disabled={message.status === "sending" || editing} onClick={() => { setPanel(null); onDelete(); }}>Remove from queue</Button>
      </div>}
      {message.error && <p role="status" className="p-2 text-sm text-muted-foreground">{message.error}</p>}
    </PopoverContent>
  </Popover>;
}
export function MessageQueue({ queue, disabled, onEdit, onSend, onDelete, onResume }: {
  queue: Queue; disabled: boolean; onEdit: (m: PendingMessage) => void; onSend: (m: PendingMessage) => void;
  onDelete: (m: PendingMessage) => void; onResume: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  if (!queue.messages.length) return null;
  return <section aria-label="Message queue" className="flex flex-col gap-1">
    <div className="flex items-center gap-2">
      <Button variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {queue.paused ? "Queue paused" : "Queue"} · {queue.messages.length}
      </Button>
      {queue.paused && <Button variant="ghost" size="sm" disabled={disabled || queue.messages.some(m => m.status === "unknown" || m.status === "sending")} onClick={onResume}>Resume queue</Button>}
    </div>
    {expanded && <div className="max-h-36 overflow-y-auto">
      {queue.messages.map((m, index) => <QueueItem key={m.id} message={m} index={index} disabled={disabled}
        onEdit={() => onEdit(m)} onSend={() => onSend(m)} onDelete={() => onDelete(m)} />)}
    </div>}
  </section>;
}
