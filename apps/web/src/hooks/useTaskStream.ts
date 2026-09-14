import { readUpdateSnapshot, useUpdateSnapshot } from "../update-state";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent, AgentEventKind, AgentKind, AssistantTextPayload, SseFrame, TaskState } from "@palmagent/shared";
import { api } from "../api";
import { connectSse, type ConnState } from "./sse";

// The first event's durable sequence is the row key. Replacing a growing text
// item preserves every other row's identity for memoized transcript rendering.
export type LogItem =
  | { key: number; kind: "assistant_text"; agent: AgentKind; text: string; messageId?: string; phase?: AssistantTextPayload["phase"] }
  | { key: number; kind: Exclude<AgentEventKind, "assistant_text">; event: AgentEvent };
export type { ConnState };

export interface TaskStream {
  log: LogItem[];
  conn: ConnState;
  loadingHistory: boolean;
  hasEarlier: boolean;
  loadingEarlier: boolean;
  historyError?: string;
  loadEarlier: () => void;
  // The scoped snapshot remains authoritative even if the inbox was suspended.
  task?: TaskState;
}

function append(items: LogItem[], event: AgentEvent, seq: number) {
  if (event.kind === "assistant_text") {
    const payload = (event.payload ?? {}) as Partial<AssistantTextPayload>;
    const text = typeof payload?.text === "string" ? payload.text : "";
    const messageId = typeof payload.messageId === "string" ? payload.messageId : undefined;
    const phase = payload.phase === "progress" || payload.phase === "final" ? payload.phase : undefined;
    const last = items.at(-1);
    if (last?.kind === "assistant_text" && last.agent === event.agent && last.messageId === messageId && last.phase === phase) items[items.length - 1] = { ...last, text: last.text + text };
    else items.push({ key: seq, kind: "assistant_text", agent: event.agent, text, messageId, phase });
  } else items.push({ key: seq, kind: event.kind, event });
}

export function useTaskStream(taskId: string): TaskStream {
  const restored = useRef(readUpdateSnapshot<{ items: LogItem[]; lastSeq: number; before: number | null; task?: TaskState }>(`history:${taskId}`));
  const checkpoint = useRef(restored.current);
  useUpdateSnapshot(`history:${taskId}`, () => checkpoint.current);
  const [log, setLog] = useState<LogItem[]>(restored.current?.items ?? []);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [task, setTask] = useState<TaskState | undefined>(restored.current?.task);
  const [loadingHistory, setLoadingHistory] = useState(!restored.current);
  const [hasEarlier, setHasEarlier] = useState(restored.current?.before != null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const load = useRef<() => void>(() => {});
  const loadEarlier = useCallback(() => load.current(), []);

  useEffect(() => {
    const saved = restored.current;
    setLog(saved?.items ?? []); setTask(saved?.task);
    let currentTask = saved?.task;
    setLoadingHistory(!saved); setHasEarlier(saved?.before != null); setLoadingEarlier(false); setHistoryError(undefined);
    let items: LogItem[] = saved ? [...saved.items] : [];
    let lastSeq = saved?.lastSeq ?? 0;
    let receivedSnapshot = Boolean(saved);
    let replayThrough = 0;
    let ready = Boolean(saved);
    let before: number | null = saved?.before ?? null;
    let animation = 0;
    let disposed = false;
    let request: AbortController | undefined;

    const publish = () => {
      animation = 0;
      checkpoint.current = { items: [...items], lastSeq, before, task: currentTask };
      setLog([...items]);
      setHasEarlier(before !== null);
      setLoadingHistory(false);
    };
    const schedule = () => {
      if (!animation) animation = requestAnimationFrame(publish);
    };

    load.current = async () => {
      if (!ready || before === null || request) return;
      const controller = new AbortController();
      request = controller;
      setLoadingEarlier(true); setHistoryError(undefined);
      try {
        const page = await api.taskHistory(taskId, before, controller.signal);
        if (disposed) return;
        const older: LogItem[] = [];
        // The server starts pages at whole-message boundaries. Filter overlap
        // defensively without changing the live cursor.
        for (const row of page.events) {
          if (row.seq < before) append(older, row.event, row.seq);
        }
        items = [...older, ...items];
        before = page.before;
        schedule();
      } catch (error) {
        if (!disposed) setHistoryError(error instanceof Error ? error.message : "Could not load earlier messages.");
      } finally {
        if (!disposed) { request = undefined; setLoadingEarlier(false); }
      }
    };

    const disconnect = connectSse(
      `/api/stream?task=${encodeURIComponent(taskId)}&tail=1`,
      (message) => {
        let frame: SseFrame;
        try { frame = JSON.parse(message.data) as SseFrame; } catch { return; }
        if (frame.type === "tasks") {
          const mine = frame.tasks.find((entry) => entry.taskId === taskId);
          if (mine) {
            currentTask = mine; setTask(mine);
            if (checkpoint.current) checkpoint.current = { ...checkpoint.current, task: mine };
          }
          if (!receivedSnapshot && frame.history) {
            lastSeq = frame.history.after;
            before = frame.history.before;
          }
          receivedSnapshot = true;
          if (!ready) {
            replayThrough = frame.replayThrough ?? 0;
            if (lastSeq >= replayThrough) { ready = true; schedule(); }
          }
          return;
        }
        if (frame.type !== "event") return;
        const seq = Number(message.lastEventId);
        if (!Number.isSafeInteger(seq) || seq <= lastSeq) return;
        lastSeq = seq;
        receivedSnapshot = true;
        append(items, frame.event, seq);
        if (ready || lastSeq >= replayThrough) { ready = true; schedule(); }
      },
      setConn,
      // Explicit zero on reconnect is significant: even an initially empty
      // session must resume every missed event instead of selecting a new tail.
      () => receivedSnapshot ? lastSeq : undefined,
    );
    return () => {
      disposed = true;
      disconnect(); request?.abort(); cancelAnimationFrame(animation);
      load.current = () => {};
    };
  }, [taskId]);

  return { log, conn, task, loadingHistory, hasEarlier, loadingEarlier, historyError, loadEarlier };
}
