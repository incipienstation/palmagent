import { useEffect, useRef, useState } from "react";
import type { AgentEvent, AgentEventKind, AgentKind, SseFrame, TaskState } from "@palmagent/shared";
import { connectSse, type ConnState } from "./sse";

// The log is a list of render items. Consecutive `assistant_text` deltas (Claude
// streams token-by-token) are coalesced into one growing bubble; every other
// event kind is its own item. Each item keeps a stable `key` for React.
export type LogItem =
  | { key: number; kind: "assistant_text"; agent: AgentKind; text: string }
  | { key: number; kind: Exclude<AgentEventKind, "assistant_text">; event: AgentEvent };

export type { ConnState };

export interface TaskStream {
  log: LogItem[];
  conn: ConnState;
  // This task's latest snapshot, taken from the `tasks` frames the scoped stream
  // also carries. The detail view trusts THIS over the inbox-provided task: the
  // scoped stream is the one that's actually connected while you're on the page,
  // so it reflects status changes (e.g. running → awaiting_input) even when the
  // long-lived inbox stream has gone stale in the background.
  task?: TaskState;
}

// Scoped stream (GET /api/stream?task=:id). The SSE `id:` is the per-task seq;
// re-dials replay everything after it. We additionally gate on a monotonic seq
// so a replayed event is never rendered twice and ordering holds.
export function useTaskStream(taskId: string): TaskStream {
  const [log, setLog] = useState<LogItem[]>([]);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [task, setTask] = useState<TaskState | undefined>(undefined);
  const lastSeq = useRef(0);
  const keyCounter = useRef(0);

  useEffect(() => {
    lastSeq.current = 0;
    keyCounter.current = 0;
    setLog([]);
    setTask(undefined);

    return connectSse(
      `/api/stream?task=${encodeURIComponent(taskId)}`,
      (e) => {
        let frame: SseFrame;
        try {
          frame = JSON.parse(e.data) as SseFrame;
        } catch {
          return;
        }
        // The scoped stream carries `tasks` snapshots too — keep this task's
        // current state so the detail view has a live, authoritative status.
        if (frame.type === "tasks") {
          const mine = frame.tasks.find((t) => t.taskId === taskId);
          if (mine) setTask(mine);
          return;
        }

        // Dedupe/replay guard: per-task seq rides on the SSE id line.
        const seq = Number(e.lastEventId);
        if (Number.isFinite(seq)) {
          if (seq <= lastSeq.current) return;
          lastSeq.current = seq;
        }

        const ev = frame.event;
        setLog((prev) => {
          if (ev.kind === "assistant_text") {
            const text = textOf(ev);
            const last = prev[prev.length - 1];
            if (last && last.kind === "assistant_text") {
              const merged: LogItem = { ...last, text: last.text + text };
              return [...prev.slice(0, -1), merged];
            }
            return [...prev, { key: keyCounter.current++, kind: "assistant_text", agent: ev.agent, text }];
          }
          return [...prev, { key: keyCounter.current++, kind: ev.kind, event: ev }];
        });
      },
      setConn,
      () => lastSeq.current,
    );
  }, [taskId]);

  return { log, conn, task };
}

function textOf(ev: AgentEvent): string {
  const p = ev.payload as { text?: unknown } | null;
  return p && typeof p.text === "string" ? p.text : "";
}
