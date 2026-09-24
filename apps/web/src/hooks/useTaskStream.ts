import { useInfiniteQuery, type InfiniteData } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, AgentEventKind, AgentKind, AssistantTextPayload, SseFrame, TaskHistoryResponse, TaskState } from "@palmagent/shared";
import { observeTaskActivity } from "../task-activity";
import { observeTaskMutation, projectTask, useTaskMutations } from "../task-mutations";
import { readUpdateSnapshot, useUpdateSnapshot } from "../update-state";
import { api } from "../api";
import { queryClient, taskHistoryKey, TASK_HISTORY_GC_TIME } from "../task-history-query";
import { connectSse, type ConnState } from "./sse";

// The first event's durable sequence is the row key. Replacing a growing text
// item preserves every other row's identity for memoized transcript rendering.
export type LogItem =
  | { key: number; kind: "assistant_text"; agent: AgentKind; text: string; messageId?: string; phase?: AssistantTextPayload["phase"] }
  | { key: number; kind: Exclude<AgentEventKind, "assistant_text">; event: AgentEvent };
export type { ConnState };

interface TaskHistoryPage {
  items: LogItem[];
  before: number | null;
  cursor: number;
  task?: TaskState;
}
type TaskHistoryData = InfiniteData<TaskHistoryPage, number | null>;

export interface TaskStream {
  log: LogItem[];
  conn: ConnState;
  loadingHistory: boolean;
  hasHistory: boolean;
  hasEarlier: boolean;
  loadingEarlier: boolean;
  historyError?: string;
  loadEarlier: () => void;
  // The scoped snapshot remains authoritative even if the inbox was suspended.
  task?: TaskState;
}

function append(items: LogItem[], event: AgentEvent, seq: number): void {
  if (event.kind === "assistant_text") {
    const payload = (event.payload ?? {}) as Partial<AssistantTextPayload>;
    const text = typeof payload.text === "string" ? payload.text : "";
    const messageId = typeof payload.messageId === "string" ? payload.messageId : undefined;
    const phase = payload.phase === "progress" || payload.phase === "final" ? payload.phase : undefined;
    const last = items.at(-1);
    if (last?.kind === "assistant_text" && last.agent === event.agent && last.messageId === messageId && last.phase === phase) {
      items[items.length - 1] = { ...last, text: last.text + text };
    } else items.push({ key: seq, kind: "assistant_text", agent: event.agent, text, messageId, phase });
  } else items.push({ key: seq, kind: event.kind, event });
}

function pageItems(response: TaskHistoryResponse): TaskHistoryPage {
  const items: LogItem[] = [];
  for (const row of response.events) append(items, row.event, row.seq);
  return { items, before: response.before, cursor: response.cursor };
}

// Deploy handoff snapshots from the previous client stored one flat transcript.
// Lift it into an InfiniteData page so an update can paint immediately and then
// continue from its saved SSE cursor.
function restoredHistory(value: unknown): TaskHistoryData | undefined {
  if (!value || typeof value !== "object") return;
  const candidate = value as Partial<TaskHistoryData> & {
    items?: LogItem[]; lastSeq?: number; before?: number | null; task?: TaskState;
  };
  if (Array.isArray(candidate.pages) && Array.isArray(candidate.pageParams) && candidate.pages.length) {
    return candidate as TaskHistoryData;
  }
  if (!Array.isArray(candidate.items) || typeof candidate.lastSeq !== "number") return;
  return {
    pages: [{ items: candidate.items, before: candidate.before ?? null, cursor: candidate.lastSeq, task: candidate.task }],
    pageParams: [null],
  };
}

export function useTaskStream(taskId: string): TaskStream {
  const queryKey = useMemo(() => taskHistoryKey(taskId), [taskId]);
  const initialData = useMemo(() => restoredHistory(readUpdateSnapshot(`history:${taskId}`)), [taskId]);
  const history = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam, signal }) => pageItems(await api.taskHistory(taskId, pageParam ?? undefined, signal)),
    initialPageParam: null as number | null,
    getPreviousPageParam: (firstPage) => firstPage.before ?? undefined,
    getNextPageParam: () => undefined,
    initialData,
    initialDataUpdatedAt: initialData ? Date.now() : undefined,
    // History changes flow through its scoped SSE connection. These defaults
    // are intentionally local to transcript queries, not application-wide.
    staleTime: Infinity,
    gcTime: TASK_HISTORY_GC_TIME,
    retry: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  useUpdateSnapshot(`history:${taskId}`, () => queryClient.getQueryData<TaskHistoryData>(queryKey));
  const [conn, setConn] = useState<ConnState>("connecting");
  const [streamTask, setStreamTask] = useState<{ taskId: string; task: TaskState }>();
  const loadingOlderRef = useRef<string | undefined>(undefined);
  const resumeLiveRef = useRef<() => void>(() => {});
  const loadEarlier = useCallback(() => {
    if (!history.data) {
      void history.refetch();
      return;
    }
    if (!history.hasPreviousPage || loadingOlderRef.current === taskId) return;
    loadingOlderRef.current = taskId;
    void history.fetchPreviousPage({ cancelRefetch: false }).finally(() => {
      if (loadingOlderRef.current === taskId) {
        loadingOlderRef.current = undefined;
        resumeLiveRef.current();
      }
    });
  }, [history.data, history.fetchPreviousPage, history.hasPreviousPage, history.refetch, taskId]);

  const historyReady = !!history.data;
  useEffect(() => {
    if (!historyReady) return;
    const currentData = () => queryClient.getQueryData<TaskHistoryData>(queryKey);
    const initial = currentData();
    let lastSeq = initial?.pages.at(-1)?.cursor ?? 0;
    let pendingTask: TaskState | undefined;
    let pendingEvents: Array<{ seq: number; event: AgentEvent }> = [];
    let animation = 0;
    let disposed = false;

    const savedTask = initial?.pages.at(-1)?.task;
    setStreamTask(savedTask ? { taskId, task: savedTask } : undefined);

    const updateLatestPage = (update: (page: TaskHistoryPage) => TaskHistoryPage) => {
      queryClient.setQueryData<TaskHistoryData>(queryKey, (data) => {
        if (!data?.pages.length) return data;
        const index = data.pages.length - 1;
        const pages = data.pages.slice();
        pages[index] = update(pages[index]);
        return { ...data, pages };
      });
    };

    const publish = () => {
      animation = 0;
      if (disposed) return;
      const events = pendingEvents;
      pendingEvents = [];
      const task = pendingTask;
      pendingTask = undefined;
      if (events.length || task) updateLatestPage((page) => {
        const items = events.length ? [...page.items] : page.items;
        for (const entry of events) append(items, entry.event, entry.seq);
        return { ...page, items, cursor: Math.max(page.cursor, lastSeq), ...(task ? { task } : {}) };
      });
    };
    const schedule = () => {
      if (!animation && loadingOlderRef.current !== taskId) animation = requestAnimationFrame(publish);
    };
    resumeLiveRef.current = schedule;

    const disconnect = connectSse(
      `/api/stream?task=${encodeURIComponent(taskId)}`,
      (message) => {
        let frame: SseFrame;
        try { frame = JSON.parse(message.data) as SseFrame; } catch { return; }
        if (frame.type === "tasks") {
          const mine = frame.tasks.find((entry) => entry.taskId === taskId);
          if (mine) {
            observeTaskMutation(mine);
            observeTaskActivity(mine);
            setStreamTask({ taskId, task: mine });
            if (loadingOlderRef.current === taskId) pendingTask = mine;
            else updateLatestPage((page) => ({ ...page, task: mine }));
          }
          return;
        }
        if (frame.type !== "event") return;
        const seq = Number(message.lastEventId);
        if (!Number.isSafeInteger(seq) || seq <= lastSeq) return;
        // Advance the reconnect cursor on receipt; publication may be batched to
        // the next frame or held until an older-page request finishes.
        lastSeq = seq;
        pendingEvents.push({ seq, event: frame.event });
        schedule();
      },
      setConn,
      // REST owns history. The stream resumes strictly after its durable fence,
      // including zero for a conversation with no saved events yet.
      () => lastSeq,
    );
    return () => {
      disposed = true;
      disconnect();
      cancelAnimationFrame(animation);
      pendingEvents = [];
      pendingTask = undefined;
      resumeLiveRef.current = () => {};
    };
  }, [taskId, historyReady, queryKey]);

  const log = useMemo(() => history.data?.pages.flatMap((page) => page.items) ?? [], [history.data]);
  const cachedTask = history.data?.pages.at(-1)?.task;
  const mutations = useTaskMutations();
  const historyError = (history.isFetchPreviousPageError && !history.isFetchingPreviousPage) ||
      (history.isError && !history.data && !history.isFetching)
    ? history.error instanceof Error ? history.error.message : "Could not load conversation history."
    : undefined;
  return {
    log,
    conn,
    task: projectTask(streamTask?.taskId === taskId ? streamTask.task : cachedTask, mutations),
    loadingHistory: history.isFetching && !history.data,
    hasHistory: !!history.data,
    hasEarlier: history.data ? history.hasPreviousPage : history.isError,
    loadingEarlier: history.isFetchingPreviousPage || (history.isFetching && !history.data),
    historyError,
    loadEarlier,
  };
}
