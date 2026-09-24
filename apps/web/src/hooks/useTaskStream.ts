import { useInfiniteQuery, type InfiniteData } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deferActivityEventDetails, type AgentEvent, type AgentEventKind, type AgentKind, type AssistantTextPayload, type SseFrame, type TaskHistoryResponse, type TaskState } from "@palmagent/shared";
import { observeTaskActivity } from "../task-activity";
import { observeTaskMutation, projectTask, useTaskMutations } from "../task-mutations";
import { readUpdateSnapshot, useUpdateSnapshot } from "../update-state";
import { api } from "../api";
import { queryClient, taskHistoryChangesKey, taskHistoryKey, TASK_HISTORY_GC_TIME } from "../task-history-query";
import { useOutputMode } from "../OutputModeProvider";
import { connectSse, type ConnState } from "./sse";

// The first event's durable sequence is the row key. Replacing a growing text
// item preserves every other row's identity for memoized transcript rendering.
export type LogItem =
  | { key: number; endSeq?: number; kind: "assistant_text"; agent: AgentKind; text: string; messageId?: string; phase?: AssistantTextPayload["phase"] }
  | { key: number; endSeq?: number; kind: Exclude<AgentEventKind, "assistant_text">; event: AgentEvent; detailsDeferred?: boolean };
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

function append(items: LogItem[], event: AgentEvent, seq: number, detailsDeferred = false): void {
  if (event.kind === "assistant_text") {
    const payload = (event.payload ?? {}) as Partial<AssistantTextPayload>;
    const text = typeof payload.text === "string" ? payload.text : "";
    const messageId = typeof payload.messageId === "string" ? payload.messageId : undefined;
    const phase = payload.phase === "progress" || payload.phase === "final" ? payload.phase : undefined;
    const last = items.at(-1);
    if (last?.kind === "assistant_text" && last.agent === event.agent && last.messageId === messageId && last.phase === phase) {
      items[items.length - 1] = { ...last, endSeq: seq, text: last.text + text };
    } else items.push({ key: seq, endSeq: seq, kind: "assistant_text", agent: event.agent, text, messageId, phase });
  } else items.push({ key: seq, endSeq: seq, kind: event.kind, event, ...(detailsDeferred ? { detailsDeferred: true } : {}) });
}

export function historyLogItems(events: TaskHistoryResponse["events"]): LogItem[] {
  const items: LogItem[] = [];
  for (const row of events) append(items, row.event, row.seq, row.detailsDeferred);
  return items;
}

function pageItems(response: TaskHistoryResponse): TaskHistoryPage {
  return { items: historyLogItems(response.events), before: response.before, cursor: response.cursor };
}

function compactHistory(data: TaskHistoryData | undefined): TaskHistoryData | undefined {
  if (!data) return;
  return {
    ...data,
    pages: data.pages.map((page) => ({ ...page, items: page.items.map((item) => {
      if (item.kind === "assistant_text" || item.detailsDeferred) return item;
      const compact = deferActivityEventDetails(item.event);
      return compact.detailsDeferred ? { ...item, event: compact.event, detailsDeferred: true } : item;
    }) })),
  };
}

// Deploy handoff snapshots from the previous client stored one flat transcript.
// Lift it into an InfiniteData page so an update can paint immediately and then
// continue from its durable history cursor.
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
  const { mode } = useOutputMode();
  const queryKey = useMemo(() => taskHistoryKey(taskId, mode), [taskId, mode]);
  const initialData = useMemo(() => {
    const restored = restoredHistory(readUpdateSnapshot(`history:${taskId}`));
    if (!restored) return undefined;
    if (mode === "compact") return compactHistory(restored);
    // A compact checkpoint intentionally omits tool payloads. Reuse a verbose
    // checkpoint across a screen update so its loaded pages and scroll anchor
    // survive, but fetch full history when the checkpoint contains summaries.
    const hasDeferredDetails = restored.pages.some((page) => page.items.some((item) =>
      item.kind !== "assistant_text" && item.detailsDeferred));
    return hasDeferredDetails ? undefined : restored;
  }, [taskId, mode]);
  const history = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam, signal }) => pageItems(await api.taskHistory(taskId, pageParam ?? undefined, mode === "verbose" ? "full" : "summary", signal)),
    initialPageParam: null as number | null,
    getPreviousPageParam: (firstPage) => firstPage.before ?? undefined,
    getNextPageParam: () => undefined,
    initialData,
    initialDataUpdatedAt: initialData ? Date.now() : undefined,
    placeholderData: (previousData) => previousData,
    // Persisted history changes are reconciled from REST against the stream
    // boundary. These defaults stay local to transcript queries.
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
    if (history.isPlaceholderData) return;
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
  }, [history.data, history.fetchPreviousPage, history.hasPreviousPage, history.isPlaceholderData, history.refetch, taskId]);

  const historyReady = !!history.data && !history.isPlaceholderData;
  useEffect(() => {
    if (!historyReady) return;
    const currentData = () => queryClient.getQueryData<TaskHistoryData>(queryKey);
    const initial = currentData();
    let appliedSeq = initial?.pages.at(-1)?.cursor ?? 0;
    let receivedSeq = appliedSeq;
    let catchupTarget = appliedSeq;
    let pendingTask: TaskState | undefined;
    let pendingEvents: Array<{ seq: number; event: AgentEvent; detailsDeferred?: boolean; bytes: number }> = [];
    let pendingBytes = 0;
    let animation = 0;
    let disposed = false;
    let recovering = false;
    let catchupPromise: Promise<void> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let catchupFailures = 0;
    let overflowReconnectRequested = false;
    let connection: ReturnType<typeof connectSse> | undefined;

    const MAX_PENDING_EVENTS = 4096;
    const MAX_PENDING_BYTES = 16 * 1024 * 1024;

    const savedTask = initial?.pages.at(-1)?.task;
    setStreamTask(savedTask ? { taskId, task: savedTask } : undefined);

    const updateLatestPage = (update: (page: TaskHistoryPage) => TaskHistoryPage): boolean => {
      const updated = queryClient.setQueryData<TaskHistoryData>(queryKey, (data) => {
        if (!data?.pages.length) return data;
        const index = data.pages.length - 1;
        const pages = data.pages.slice();
        pages[index] = update(pages[index]);
        return { ...data, pages };
      });
      return !!updated?.pages.length;
    };

    const publish = () => {
      animation = 0;
      if (disposed) return;
      if (recovering) return;
      const events = pendingEvents.sort((a, b) => a.seq - b.seq);
      pendingEvents = [];
      pendingBytes = 0;
      const task = pendingTask;
      pendingTask = undefined;
      const fresh = events.filter((entry) => entry.seq > appliedSeq);
      if (fresh.length || task) {
        const nextSeq = fresh.reduce((value, entry) => Math.max(value, entry.seq), appliedSeq);
        if (updateLatestPage((page) => {
          const items = fresh.length ? [...page.items] : page.items;
          for (const entry of fresh) append(items, entry.event, entry.seq, entry.detailsDeferred);
          return { ...page, items, cursor: Math.max(page.cursor, nextSeq), ...(task ? { task } : {}) };
        })) appliedSeq = nextSeq;
      }
      receivedSeq = Math.max(receivedSeq, appliedSeq);
    };
    const schedule = () => {
      if (!recovering && !animation && loadingOlderRef.current !== taskId) animation = requestAnimationFrame(publish);
    };
    resumeLiveRef.current = schedule;

    const beginCatchup = () => {
      if (disposed || catchupPromise) return;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; }
      if (appliedSeq >= catchupTarget) {
        recovering = false;
        schedule();
        return;
      }
      recovering = true;
      const running = (async () => {
        try {
          while (!disposed && appliedSeq < catchupTarget) {
            const through = catchupTarget;
            let after = appliedSeq;
            while (!disposed && after < through) {
              const key = taskHistoryChangesKey(taskId, after, through, mode);
              let page;
              try {
                page = await queryClient.fetchQuery({
                  queryKey: key,
                  queryFn: ({ signal }) => api.taskHistoryChanges(taskId, after, through,
                    mode === "compact" ? "summary" : "full", signal),
                  staleTime: Number.POSITIVE_INFINITY,
                  gcTime: TASK_HISTORY_GC_TIME,
                  retry: false,
                });
              } finally {
                queryClient.removeQueries({ queryKey: key, exact: true });
              }
              if (disposed) return;
              if (page.after !== after || page.through !== through) throw new Error("History catch-up boundary changed");
              const nextAfter = page.nextAfter ?? page.through;
              if (nextAfter < after || nextAfter > through || (page.nextAfter !== null && nextAfter === after)) {
                throw new Error("Invalid history catch-up cursor");
              }
              if (!updateLatestPage((historyPage) => {
                const items = page.events.length ? [...historyPage.items] : historyPage.items;
                for (const entry of page.events) append(items, entry.event, entry.seq, entry.detailsDeferred);
                return { ...historyPage, items, cursor: Math.max(historyPage.cursor, nextAfter) };
              })) throw new Error("History query disappeared during catch-up");
              appliedSeq = nextAfter;
              receivedSeq = Math.max(receivedSeq, appliedSeq);
              after = nextAfter;
            }
            if (disposed) return;
            if (after < through) throw new Error("History catch-up did not reach its boundary");
          }
          if (!disposed) {
            recovering = false;
            catchupFailures = 0;
            overflowReconnectRequested = false;
            schedule();
          }
        } catch {
          // Keep live frames buffered behind a failed REST gap and retry with
          // backoff; advancing either cursor here would lose durable events.
          catchupFailures++;
        }
      })();
      catchupPromise = running;
      void running.finally(() => {
        if (catchupPromise === running) catchupPromise = undefined;
        if (recovering && !disposed && !retryTimer) {
          const delay = Math.min(1000 * 2 ** Math.min(catchupFailures - 1, 4), 10_000);
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            beginCatchup();
          }, delay);
        }
      });
    };

    connection = connectSse(
      `/api/stream?task=${encodeURIComponent(taskId)}${mode === "compact" ? "&details=summary" : ""}`,
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
          if (Number.isSafeInteger(frame.historyThrough) && frame.historyThrough! > appliedSeq) {
            catchupTarget = Math.max(catchupTarget, frame.historyThrough!);
            recovering = true;
            overflowReconnectRequested = false;
            beginCatchup();
          }
          return;
        }
        if (frame.type !== "event") return;
        const seq = Number(message.lastEventId);
        if (!Number.isSafeInteger(seq) || seq <= Math.max(appliedSeq, receivedSeq)) return;
        receivedSeq = seq;
        const bytes = JSON.stringify(frame.event).length * 2;
        if (pendingEvents.length >= MAX_PENDING_EVENTS || pendingBytes + bytes > MAX_PENDING_BYTES) {
          pendingEvents = [];
          pendingBytes = 0;
          if (!overflowReconnectRequested) {
            overflowReconnectRequested = true;
            connection?.reconnect();
          }
          return;
        }
        pendingEvents.push({ seq, event: frame.event, detailsDeferred: frame.detailsDeferred, bytes });
        pendingBytes += bytes;
        schedule();
      },
      setConn,
    );
    return () => {
      disposed = true;
      connection?.close();
      if (retryTimer) clearTimeout(retryTimer);
      cancelAnimationFrame(animation);
      pendingEvents = [];
      pendingBytes = 0;
      pendingTask = undefined;
      resumeLiveRef.current = () => {};
      if (mode === "compact") queryClient.setQueryData<TaskHistoryData>(queryKey, (data) => compactHistory(data));
    };
  }, [taskId, historyReady, queryKey, mode]);

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
