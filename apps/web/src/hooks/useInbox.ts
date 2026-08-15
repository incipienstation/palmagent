import { useEffect, useRef, useState } from "react";
import type { SseFrame, TaskState } from "@palmagent/shared";
import { connectSse, type ConnState } from "./sse";

export type { ConnState };

export interface Inbox {
  tasks: TaskState[];
  conn: ConnState;
}

// The ONE inbox stream (GET /api/stream). The server pushes a fresh `tasks`
// snapshot on connect and on every state change, so the inbox just mirrors the
// latest snapshot — it ignores per-event frames (the task detail consumes those
// on its scoped stream). connectSse re-dials on foreground/online and replays
// from the last event id, so the next snapshot resyncs us after a mobile gap.
export function useInbox(): Inbox {
  const [tasks, setTasks] = useState<TaskState[]>([]);
  const [conn, setConn] = useState<ConnState>("connecting");
  const lastId = useRef<string>("");

  useEffect(() => {
    return connectSse(
      "/api/stream",
      (e) => {
        if (e.lastEventId) lastId.current = e.lastEventId; // track the global id high-water-mark
        let frame: SseFrame;
        try {
          frame = JSON.parse(e.data) as SseFrame;
        } catch {
          return;
        }
        if (frame.type === "tasks") setTasks(frame.tasks);
      },
      setConn,
      () => lastId.current,
    );
  }, []);

  return { tasks, conn };
}
