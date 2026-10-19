import { useEffect, useLayoutEffect, useRef } from "react";
import { ArrowLeft, ArrowUp, MoreVertical, Square } from "lucide-react";
import type { TaskState } from "@palmagent/shared";
import type { useSideChat } from "../hooks/useSideChat";
import { useSendShortcut } from "../SendShortcutProvider";
import { useBlockNavigationGestures } from "../NavigationGestureProvider";
import { useBackLayer } from "../hooks/useBackLayer";
import { Button } from "./ui/button";
import { Alert } from "./ui/alert";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "./ui/input-group";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Markdown } from "./Markdown";

export function SideChat({ side, task, onClose, onAddToDraft, draftDisabled }: {
  side: ReturnType<typeof useSideChat>; task: TaskState; onClose(): void; onAddToDraft(text: string): void; draftDisabled?: boolean;
}) {
  const { snapshot, draft, setDraft, busy } = side;
  const input = useRef<HTMLTextAreaElement>(null), viewport = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const { shortcut } = useSendShortcut();
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
    <ScrollArea className="flex-1" contentClassName="flex flex-col gap-5 p-4" viewportProps={{
      ref: viewport, "aria-label": "Side conversation", onScroll: event => {
        const el = event.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
      },
    }}>
      {!snapshot?.messages.length && <p className="text-sm text-muted-foreground">Ask a side question using the current conversation as context.</p>}
      {snapshot?.messages.map(message => <article key={message.id} className="min-w-0 break-words text-sm [overflow-wrap:anywhere]">
        <p className="mb-1 text-xs text-muted-foreground">{message.role === "user" ? "You" : "Codex"}</p>
        <Markdown streaming={running && message.role === "assistant"}>{message.text}</Markdown>
        {message.role === "assistant" && message.text && !running &&
          <Button variant="ghost" size="sm" className="mt-2" disabled={draftDisabled || closed}
            title={draftDisabled ? "Finish editing the queued message first" : undefined}
            onClick={() => onAddToDraft(message.text)}>Add to draft</Button>}
      </article>)}
      {running && <p role="status" className="text-sm text-muted-foreground">Thinking…</p>}
    </ScrollArea>
    <footer className="flex shrink-0 flex-col gap-2 border-t p-3 pb-[calc(12px+var(--safe-bottom))]">
      {(side.error || snapshot?.error) && <Alert role="alert">{side.error ?? snapshot?.error}</Alert>}
      {ended && <div className="flex items-center justify-between gap-2">
        <p role="status" className="text-sm text-muted-foreground">Side chat ended</p>
        <Button variant="outline" disabled={busy || closed} onClick={() => void side.restart()}>New side chat</Button>
      </div>}
      {!snapshot && !busy && <Button variant="outline" disabled={closed} onClick={() => void side.restart()}>Retry connection</Button>}
      <InputGroup className="rounded-3xl">
        <InputGroupTextarea ref={input} aria-label="Side question" value={draft} onChange={event => setDraft(event.target.value)}
          placeholder={busy && !snapshot ? "Opening side chat…" : "Ask a side question…"} rows={2} maxLength={16000}
          className="block max-h-36 w-full flex-none px-3 py-2.5" onKeyDown={event => {
            if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
            if (event.key !== "Enter" || event.shiftKey || event.altKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.repeat) return;
            if (shortcut !== "enter" && !event.ctrlKey && !event.metaKey) return;
            event.preventDefault();
            if (ready && !busy && !closed && draft.trim()) { stick.current = true; void side.send(); }
          }} />
        <InputGroupAddon align="block-end" className="justify-end p-1">
          {running ? <Button variant="ghost" size="icon-lg" aria-label="Stop side response" disabled={busy} onClick={() => void side.stop()}><Square /></Button> :
            <Button size="icon-lg" aria-label="Send side question" disabled={!ready || busy || closed || !draft.trim()}
              onClick={() => { stick.current = true; void side.send(); }}><ArrowUp /></Button>}
        </InputGroupAddon>
      </InputGroup>
    </footer>
  </aside>;
}
