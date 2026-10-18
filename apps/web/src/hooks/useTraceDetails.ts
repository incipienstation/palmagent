import { historyLogItems } from "./useTaskStream";
import type { LogItem } from "@palmagent/shared";
import { useEffect } from "react";
import { useInfiniteQuery, useQueries, type QueryKey } from "@tanstack/react-query";
import { api } from "../api";
import { queryClient, taskActivityDetailsKey, TASK_ACTIVITY_DETAILS_GC_TIME } from "../task-history-query";

function useTraceRevision(key: QueryKey, revision: number, cursor: number | undefined, fetching: boolean, error: boolean, enabled: boolean) {
  const identity = JSON.stringify(key);
  useEffect(() => {
    if (!enabled || cursor === undefined || cursor >= revision || fetching || error) return;
    const timer = setTimeout(() => { void queryClient.invalidateQueries({ queryKey: JSON.parse(identity), exact: true }, { cancelRefetch: false }); }, 300);
    return () => clearTimeout(timer);
  }, [identity, revision, cursor, fetching, error, enabled]);
}

export function useTraceSteps(taskId: string | undefined, key: number, revision: number, enabled: boolean, identity = key) {
  const queryKey = [...taskActivityDetailsKey(taskId ?? "", identity), "steps"];
  const query = useInfiniteQuery({
    queryKey, enabled: !!taskId && enabled, initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => api.conversationSteps(taskId!, key, pageParam || undefined, signal),
    getNextPageParam: page => page.nextAfter ?? undefined,
    staleTime: Infinity, gcTime: TASK_ACTIVITY_DETAILS_GC_TIME, retry: false, refetchOnWindowFocus: false,
  });
  useTraceRevision(queryKey, revision, query.data && Math.min(...query.data.pages.map(page => page.cursor)), query.isFetching, query.isError, enabled);
  return query;
}

export function useTraceStepDetails(taskId: string, key: number, step: number, revision: number) {
  const queryKey = [...taskActivityDetailsKey(taskId, 0), "step", step];
  const query = useInfiniteQuery({
    queryKey, initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => api.conversationStepDetails(taskId, key, step, pageParam || undefined, signal),
    getNextPageParam: page => page.nextAfter ?? undefined,
    staleTime: Infinity, gcTime: TASK_ACTIVITY_DETAILS_GC_TIME, retry: false, refetchOnWindowFocus: false,
  });
  useTraceRevision(queryKey, revision, query.data && Math.min(...query.data.pages.map(page => page.cursor)), query.isFetching, query.isError, true);
  return query;
}

export function useLegacyTraceDetails(taskId: string | undefined, deferred: LogItem[]) {
  return useQueries({ queries: deferred.map(item => ({
    queryKey: [...taskActivityDetailsKey(taskId ?? "", 0), "legacy-member", item.key],
    enabled: !!taskId, staleTime: Infinity, gcTime: TASK_ACTIVITY_DETAILS_GC_TIME, retry: false,
    queryFn: async ({ signal }: { signal: AbortSignal }) => historyLogItems((await api.taskActivityDetails(taskId!, item.key, item.key, signal)).events),
  })) });
}
