import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, MoreVertical, Plus } from "lucide-react";
import type { TaskState } from "@palmagent/shared";
import type { useSideChat } from "../hooks/useSideChat";
import { useBlockNavigationGestures } from "../NavigationGestureProvider";
import { useBackLayer } from "../hooks/useBackLayer";
import { Button } from "./ui/button";
import { Alert } from "./ui/alert";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import { InputGroupAddon } from "./ui/input-group";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { AssistantMessage, UserBubble } from "./ChatMessage";
import { ComposerAction, ComposerInput, ComposerSurface } from "./ComposerPrimitives";
import { WorkingLabel } from "./WorkingLabel";

export function SideChat({ side, task, onClose, onAddToDraft, draftDisabled }: {
  side: ReturnType<typeof useSideChat>; task: TaskState; onClose(): void; onAddToDraft(text: string): void; draftDisabled?: boolean;
}) {
  const { snapshot, draft, setDraft, busy } = side;
  const input = useRef<HTMLTextAreaElement>(null), viewport = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [focused, setFocused] = useState(false);
  const expanded = !!draft.trim() || focused;
  useLayoutEffect(() => {
    if (focused && !input.current?.closest(".composer")?.contains(document.activeElement)) setFocused(false);
  });
  useBackLayer(side.open, onClose);
  useBlockNavigationGestures(side.open);
  useEffect(() => {
    if (!side.open) return;
    const frame = requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [side.open]);
  useLayoutEffect(() => {
    if (side.open && stick.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [side.open, snapshot?.revision]);
  const running = snapshot?.status === "running";
  const ended = snapshot?.status === "ended";
  const ready = snapshot?.status === "idle";
  const cannotSend = !ready || busy || !draft.trim() || task.status === "archived" || task.status === "cancelled";
  const send = () => { stick.current = true; void side.send(); };
  const closed = task.status === "archived" || task.status === "cancelled";
  const mainStatus = task.status === "running" ? "Main task running" :
    task.status === "awaiting_input" || task.status === "awaiting_approval" ? "Main task needs input" :
    task.status === "queued" ? "Main task queued" : closed ? "Main task closed" : task.status === "failed" ? "Main task failed" : "Main task idle";
  return <aside hidden={!side.open} aria-label="Side chat"
    onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); onClose(); } }}
    className={side.open ? "flex h-[var(--app-height,100dvh)] min-w-0 flex-1 flex-col bg-background lg:max-w-[480px] lg:border-l" : "hidden"}>
    <header className="flex shrink-0 items-center gap-2 border-b px-3 pb-2 pt-[calc(8px+var(--safe-top))]">
      <Button variant="ghost" size="icon-lg" aria-label="Back to main chat" onClick={onClose}><ArrowLeft /></Button>
      <div className="min-w-0 flex-1"><h2 className="text-base font-semibold">Side chat</h2>
        <Button variant="link" size="sm" className="h-auto p-0" onClick={onClose}>{mainStatus}</Button>
      </div>
      <Badge variant="secondary">Read only</Badge>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-lg" aria-label="Side chat actions"><MoreVertical /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end"><DropdownMenuGroup>
          <DropdownMenuItem disabled={!side.hasSession || busy} onSelect={() => void side.end()}>End side chat</DropdownMenuItem>
        </DropdownMenuGroup></DropdownMenuContent>
      </DropdownMenu>
    </header>
    <ScrollArea className="flex-1" contentClassName="flex flex-col px-4 py-3" viewportProps={{
      ref: viewport, "aria-label": "Side conversation", onScroll: event => {
        const el = event.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
      },
    }}>
      {!snapshot?.messages.length && <p className="text-sm text-muted-foreground">Ask a side question using the current conversation as context.</p>}
      {snapshot?.messages.map((message, index) => message.role === "user" ?
        <UserBubble key={message.id} text={message.text} /> :
        <AssistantMessage key={message.id} text={message.text} streaming={running && index === snapshot.messages.length - 1}>
          {message.text && !running && <div className="flex items-center">
            <Button variant="ghost" size="sm" disabled={draftDisabled || closed}
              title={draftDisabled ? "Finish editing the queued message first" : undefined}
              onClick={() => onAddToDraft(message.text)}><Plus data-icon="inline-start" />Add to draft</Button>
          </div>}
        </AssistantMessage>)}
      {running && <WorkingLabel />}
    </ScrollArea>
    <footer className="flex shrink-0 flex-col gap-2 border-t p-3 pb-[calc(12px+var(--safe-bottom))]">
      {(side.error || snapshot?.error) && <Alert role="alert">{side.error ?? snapshot?.error}</Alert>}
      {ended && <div className="flex items-center justify-between gap-2">
        <p role="status" className="text-sm text-muted-foreground">Side chat ended</p>
        <Button variant="outline" disabled={busy || closed} onClick={() => void side.restart()}>New side chat</Button>
      </div>}
      {!snapshot && !busy && <Button variant="outline" disabled={closed} onClick={() => void side.restart()}>Retry connection</Button>}
      <ComposerSurface aria-label="Side message composer" data-expanded={expanded} data-leading-control="false" pending={busy}
        onFocusCapture={event => { if (event.currentTarget.contains(event.target)) setFocused(true); }}
        onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
        <ComposerInput textarea={input} id={`side-question-${task.taskId}`} expanded={expanded} aria-label="Side question" value={draft}
          onChange={event => setDraft(event.target.value)} maxLength={16000}
          placeholder={busy && !snapshot ? "Opening side chat…" : "Ask a side question…"}
          cannotSend={cannotSend} onSend={send} />
        <InputGroupAddon align="inline-end" className="composer-toolbar composer-actions min-w-0 basis-full justify-end gap-1">
          {running ? <ComposerAction stop aria-label="Stop side response" disabled={busy} onClick={() => void side.stop()} /> :
            <ComposerAction aria-label="Send side question" disabled={cannotSend} busy={busy} onClick={send} />}
        </InputGroupAddon>
      </ComposerSurface>
    </footer>
  </aside>;
}
