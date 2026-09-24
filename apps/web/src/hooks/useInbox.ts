import { observeTaskActivity } from "../task-activity";
import { observeTaskMutation, projectTask, useTaskMutations } from "../task-mutations";
import { clientReadKeys } from "../client-query-keys";
import { queryClient } from "../query-client";
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

// The inbox needs fresh task snapshots, including after mobile reconnects.
// The selected session owns the scoped chat event stream.
export function useInbox(): Inbox {
  const mutations = useTaskMutations();
  const [tasks, setTasks] = useState<TaskState[]>([]);
  const snapshot = useRef<TaskState[]>([]);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const connection = connectSse(
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
          incoming.forEach(task => { observeTaskMutation(task); observeTaskActivity(task); });
          const next = reconcileTasks(snapshot.current, incoming);
          if (next !== snapshot.current) {
            void queryClient.invalidateQueries({ queryKey: clientReadKeys.usage(), refetchType: "active" });
            void queryClient.invalidateQueries({ queryKey: clientReadKeys.routineRunsAll(), refetchType: "active" });
          }
          snapshot.current = next;
          setTasks(next);
          setLoading(false);
        }
        if (frame.type === "updates") updatesChanged();
      },
      setConn,
    );
    return () => connection.close();
  }, []);

  return { tasks: tasks.filter(task => !mutations.get(task.taskId)?.hidden).map(task => projectTask(task, mutations)!), conn, loading };
}
