import { readCache } from "../read-cache";
import { reconcileTasks } from "../task-snapshot";
import { updatesChanged } from "../update-events";
import { observeServerVersion } from "../pwa";
import { useEffect, useRef, useState } from "react";
import type { SseFrame, TaskState } from "@palmagent/shared";
import { connectSse, type ConnState } from "./sse";

export type { ConnState };

export interface Inbox {
  tasks: TaskState[];
  conn: ConnState;
  loading: boolean;
}

// The inbox needs only fresh task snapshots, including after mobile reconnects.
// Event replay is reserved for the selected session's scoped stream.
export function useInbox(): Inbox {
  const [tasks, setTasks] = useState<TaskState[]>([]);
  const snapshot = useRef<TaskState[]>([]);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    return connectSse(
      "/api/stream?snapshots=1",
      (e) => {
        let frame: SseFrame;
        try {
          frame = JSON.parse(e.data) as SseFrame;
        } catch {
          return;
        }
        if (frame.type === "tasks") {
          observeServerVersion(frame.version);
          const incoming = frame.tasks;
          const next = reconcileTasks(snapshot.current, incoming);
          if (next !== snapshot.current) readCache.invalidate(key => key === "/api/usage" || key.endsWith("/runs"));
          snapshot.current = next;
          setTasks(next);
          setLoading(false);
        }
        if (frame.type === "updates") updatesChanged();
      },
      setConn,
      () => undefined,
    );
  }, []);

  return { tasks, conn, loading };
}
