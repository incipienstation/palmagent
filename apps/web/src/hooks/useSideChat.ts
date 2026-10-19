import { useEffect, useRef, useState } from "react";
import type { SideChatSnapshot } from "@palmagent/shared";
import { api } from "../api";
import { useUpdateState } from "../update-state";

export const sideChatCommand = (text: string) => /^\/(?:btw|side)(?:\s+([\s\S]*))?$/.exec(text.trim());

export function useSideChat(taskId: string, enabled: boolean) {
  const [open, setOpen] = useUpdateState(`side:${taskId}:open`, false);
  const [draft, setDraft] = useUpdateState(`side:${taskId}:draft`, "");
  const [snapshot, setSnapshot] = useUpdateState<SideChatSnapshot | null>(`side:${taskId}:snapshot`, null);
  const [seen, setSeen] = useUpdateState(`side:${taskId}:seen`, "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const latest = useRef(snapshot), pending = useRef(false), epoch = useRef(0), mounted = useRef(true);
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const pendingMessage = useRef<{ sessionId: string; messageId: string; text: string } | null>(null);
  const accept = (next: SideChatSnapshot | null) => {
    if (!mounted.current) return;
    const current = latest.current;
    if (next && current?.id === next.id && current.revision > next.revision) return;
    if (!next && current) next = { ...current, status: "ended", error: "This temporary side chat has ended. Start a new side chat." };
    const sent = pendingMessage.current;
    if (next && sent?.sessionId === next.id && next.messages.some(message => message.id === sent.messageId)) {
      setDraft(value => value.trim() === sent.text ? "" : value);
      pendingMessage.current = null;
    }
    latest.current = next; setSnapshot(next);
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; }; }, []);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const version = epoch.current;
      try {
        if (document.visibilityState !== "hidden") {
          const next = await api.sideChat.get(taskId);
          if (!stopped && version === epoch.current && !pending.current) accept(next);
        }
      } catch { /* A temporary polling failure must not erase the conversation. */ }
      if (!stopped && latest.current && latest.current.status !== "ended")
        timer = setTimeout(poll, latest.current.status === "running" ? 1000 : 5000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [taskId, enabled, snapshot?.status]);
  useEffect(() => {
    if (open && snapshot) setSeen(`${snapshot.id}:${snapshot.completed}`);
  }, [open, snapshot?.id, snapshot?.completed, setSeen]);
  async function operation(action: () => Promise<SideChatSnapshot>) {
    if (pending.current) return null;
    pending.current = true; epoch.current++; setBusy(true); setError(undefined);
    try { const next = await action(); accept(next); return next; }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : "Side chat is unavailable."); return null; }
    finally { pending.current = false; epoch.current++; if (mounted.current) setBusy(false); }
  }
  async function send(text = draft, session = latest.current) {
    if (!session || session.status !== "idle" || !text.trim()) return false;
    const previous = pendingMessage.current;
    const message = previous?.sessionId === session.id && previous.text === text.trim() ? previous :
      { sessionId: session.id, messageId: crypto.randomUUID(), text: text.trim() };
    pendingMessage.current = message;
    const next = await operation(() => api.sideChat.send(taskId, message));
    // A confirmed snapshot retains the submitted question, even if the provider
    // subsequently lost its connection. Never silently retry an uncertain send.
    if (next) setDraft(current => current === text ? "" : current);
    return !!next;
  }
  async function show(question?: string) {
    setOpen(true);
    if (question) setDraft(current => current ? `${current}\n\n${question}` : question);
    let session = latest.current;
    const opening = !session;
    if (opening) session = await operation(() => api.sideChat.open(taskId));
    if (question && session?.status === "idle" && !draft && (!opening || currentDraft.current === question)) await send(question, session);
    return true;
  }
  const hasSession = !!snapshot && snapshot.status !== "ended";
  return {
    open, draft, setDraft, snapshot, busy, error, hasSession,
    unread: !open && !!snapshot?.completed && seen !== `${snapshot.id}:${snapshot.completed}`,
    show, hide: () => setOpen(false), send,
    restart: () => operation(() => api.sideChat.open(taskId)),
    stop: () => latest.current && operation(() => api.sideChat.stop(taskId, latest.current!.id)),
    end: () => latest.current && operation(() => api.sideChat.end(taskId, latest.current!.id)),
  };
}
