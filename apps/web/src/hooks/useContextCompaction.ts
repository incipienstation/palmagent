import { compactUnavailableReason, type CompactTaskRequest, type MessageQueue, type TaskState } from "@palmagent/shared";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { acceptMessageQueue, beginTaskAction } from "../task-activity";
import { cacheSession } from "../query-lifecycle";
import { useTaskOperations } from "./remote-operations";
import { usePersistedFlag } from "./useDraft";

export function useContextCompaction(task: TaskState | undefined, queue: MessageQueue | undefined, busy: boolean, onCommandAccepted: () => void) {
  const operations = useTaskOperations(task?.taskId ?? "new");
  const [explained, setExplained] = usePersistedFlag("pref:context-compaction-explained");
  const [intro, setIntro] = useState<"menu" | "command" | "statusline" | null>(null);
  const [error, setError] = useState<string>();
  const pending = useRef<CompactTaskRequest | undefined>(undefined);
  const source = useRef<"menu" | "command" | "statusline">("menu");
  const currentTask = useRef(task?.taskId);
  currentTask.current = task?.taskId;
  useEffect(() => { setIntro(null); setError(undefined); pending.current = undefined; }, [task?.taskId]);
  const reason = task ? compactUnavailableReason({ ...task, messageQueue: queue }) : "Available after the first response.";
  const unavailable = reason ?? (busy ? "Wait for the current action to finish." : undefined);
  const state = queue?.compaction;
  useEffect(() => { if (queue?.runId && !queue.compaction) setError(undefined); }, [queue?.runId, queue?.compaction]);

  async function execute() {
    if (!task) return;
    if (unavailable) { setError(unavailable); return; }
    const finish = beginTaskAction(task.taskId, "compact");
    if (!finish) return;
    const generation = cacheSession();
    setError(undefined);
    const request = pending.current ?? { requestId: crypto.randomUUID(), expectedRevision: queue?.revision ?? 0 };
    pending.current = request;
    try {
      const updated = await operations.compact(request);
      if (generation !== cacheSession() || currentTask.current !== task.taskId) return;
      if (updated.messageQueue) acceptMessageQueue(task.taskId, updated.messageQueue);
      pending.current = undefined;
      if (source.current === "command") onCommandAccepted();
    } catch (error) {
      if (generation !== cacheSession() || currentTask.current !== task.taskId) return;
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) pending.current = undefined;
      setError(error instanceof Error ? error.message : "Context compaction could not start.");
      try {
        const updated = await operations.getTask();
        if (generation === cacheSession() && currentTask.current === task.taskId && updated.messageQueue) {
          acceptMessageQueue(task.taskId, updated.messageQueue);
          if (updated.messageQueue.compaction?.requestId === request.requestId) {
            pending.current = undefined; setError(undefined);
            if (source.current === "command") onCommandAccepted();
          }
        }
      } catch { /* Reconnect will reconcile the durable action status. */ }
    } finally { finish(); }
  }

  function request(from: "menu" | "command" | "statusline" = "menu") {
    source.current = from;
    if (unavailable) { setError(unavailable); return; }
    if (!explained) setIntro(from);
    else void execute();
  }

  return {
    request, unavailable, intro, source,
    closeIntro: () => setIntro(null),
    confirm: () => { setExplained(true); setIntro(null); void execute(); },
    retry: () => request(source.current),
    running: state?.status === "running",
    error: state?.status === "running" ? undefined : error ?? (state?.status === "failed" ? state.error : undefined),
  };
}
