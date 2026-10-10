import { ArrowLeft, X } from "lucide-react";
import type { TaskState } from "@palmagent/shared";
import type { ConnState } from "../hooks/useInbox";
import type { GameDelivery } from "./play-events";
import { Button } from "../components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetHeaderRow, SheetTitle, SheetDescription } from "../components/ui/sheet";
import { RobotArt, SurvivorGame } from "./scrap-survivor/api";
import { survivorStorage } from "./survivor-storage";

export function SurvivorSheet({ open, onOpenChange, onCloseAutoFocus, tasks, taskId, delivery, conn, onReturn }: {
  open: boolean; onOpenChange: (open: boolean) => void; onCloseAutoFocus: (event: Event) => void;
  tasks: TaskState[]; taskId?: string; delivery?: GameDelivery; conn: ConnState; onReturn: (id?: string) => void;
}) {
  const task = tasks.find(t => t.taskId === taskId), failed = delivery?.state === "failed";
  const status = failed ? "Send failed or unconfirmed" : delivery?.state === "sending" ? "Sending your message…"
    : conn !== "open" ? "Reconnecting — task status may be out of date"
    : task?.status === "awaiting_input" ? "Agent needs your answer" : task?.status === "awaiting_approval" ? "Agent needs approval"
    : task?.status === "running" || task?.status === "queued" ? "Agent working" : task?.status === "idle" ? "Agent is idle"
    : task?.status === "failed" ? "Task failed" : delivery?.state === "sent" ? "Message delivered" : "Ready when you are";
  return <Sheet open={open} onOpenChange={onOpenChange} autoFocus>
    <SheetContent showClose={false} size="panel" className="survivor-game h-[900px] max-h-[calc(var(--app-height,100dvh)-8px)]" onCloseAutoFocus={onCloseAutoFocus}>
      <SheetHeader className="pb-1">
        <SheetHeaderRow><div className="flex min-w-0 flex-1 items-center gap-2"><div className="survivor-title-art"><RobotArt /></div><div><p className="survivor-eyebrow">ARCADE / SURVIVAL</p><SheetTitle>Scrap Survivor</SheetTitle></div></div><Button variant="ghost" size="icon-lg" aria-label="Close game" onClick={() => onOpenChange(false)}><X /></Button></SheetHeaderRow>
        <SheetDescription className="sr-only">Move to survive. Weapons fire automatically. Collect scrap and choose upgrades.</SheetDescription>
      </SheetHeader>
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 text-sm"><p role="status" className="min-w-0 truncate">{status}</p><Button variant="outline" size="sm" onClick={() => onReturn(taskId)}><ArrowLeft data-icon="inline-start" />Back to chat</Button></div>
      <SurvivorGame active={open} storage={survivorStorage} blockedReason={failed ? "Message delivery needs attention" : undefined}
        newRunRequest={delivery?.state === "sending" ? delivery.id : undefined} onExit={() => onReturn(taskId)} />
    </SheetContent>
  </Sheet>;
}
