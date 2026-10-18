import { useInfiniteQuery } from "@tanstack/react-query";
import type { ExecutionRecord } from "@palmagent/shared";
import { api } from "../api";
import { taskActivityDetailsKey, TASK_ACTIVITY_DETAILS_GC_TIME } from "../task-history-query";

export function useExecutionRecords(taskId: string) {
  return useInfiniteQuery({
    queryKey: [...taskActivityDetailsKey(taskId, 0), "records"], initialPageParam: null as number | null,
    queryFn: ({ pageParam, signal }) => api.executionRecords(taskId, pageParam ?? undefined, signal),
    getNextPageParam: page => page.before ?? undefined,
    staleTime: Infinity, gcTime: TASK_ACTIVITY_DETAILS_GC_TIME, retry: false, refetchOnWindowFocus: false,
  });
 }

export function useExecutionRecordContent(taskId: string, record: ExecutionRecord) {
  return useInfiniteQuery({
    queryKey: [...taskActivityDetailsKey(taskId, 0), "record", record.key, record.version],
    enabled: record.body === undefined, initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => api.executionRecordContent(taskId, record.key, record.version, pageParam, signal),
    getNextPageParam: page => page.nextOffset ?? undefined,
    staleTime: Infinity, gcTime: TASK_ACTIVITY_DETAILS_GC_TIME, retry: false, refetchOnWindowFocus: false,
  });
 }
