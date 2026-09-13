import { updatesChanged } from "../update-events";
import { observeServerVersion } from "../pwa";
import { useEffect, useState } from "react";
import type { SseFrame, TaskState } from "@palmagent/shared";
import { connectSse, type ConnState } from "./sse";

export type { ConnState };

export interface Inbox {
  tasks: TaskState[];
  conn: ConnState;
}

// The inbox needs only fresh task snapshots, including after mobile reconnects.
// Event replay is reserved for the selected session's scoped stream.
export function useInbox(): Inbox {
  const [tasks, setTasks] = useState<TaskState[]>([]);
  const [conn, setConn] = useState<ConnState>("connecting");

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
          setTasks(frame.tasks);
        }
        if (frame.type === "updates") updatesChanged();
      },
      setConn,
      () => undefined,
    );
  }, []);

  return { tasks, conn };
}
