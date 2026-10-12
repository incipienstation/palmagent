import { useEffect } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { ConversationContentRef, ConversationItem, TranscriptRow } from "@palmagent/shared";
import { api } from "../api";
import { queryClient, taskActivityDetailsKey, TASK_ACTIVITY_DETAILS_GC_TIME } from "../task-history-query";

export function useConversationContent(taskId: string, content: ConversationContentRef) {
  const query = useQuery({
    queryKey: [...taskActivityDetailsKey(taskId, content.key), "content", content.member, content.version],
    enabled: false, staleTime: Infinity, gcTime: TASK_ACTIVITY_DETAILS_GC_TIME, retry: false,
    queryFn: async ({ signal }) => {
      const chunks: string[] = [];
      let offset = 0;
      while (true) {
        const page = await api.conversationContent(taskId, content, offset, signal);
        if (page.version !== content.version || (page.nextOffset !== null && page.nextOffset <= offset)) throw new Error("Content changed while loading.");
        chunks.push(page.chunk);
        if (page.nextOffset === null) return JSON.parse(chunks.join("")) as TranscriptRow;
        offset = page.nextOffset;
      }
    },
  });
  return query;
}

export function useConversationActivityDetails(taskId: string, itemKey: number, revision: number) {
  const queryKey = [...taskActivityDetailsKey(taskId, itemKey), "conversation"];
  const query = useInfiniteQuery({
    queryKey, initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => api.conversationDetails(taskId, itemKey, pageParam || undefined, signal),
    getNextPageParam: page => page.nextAfter ?? undefined,
    staleTime: Infinity, gcTime: TASK_ACTIVITY_DETAILS_GC_TIME, retry: false,
    refetchOnWindowFocus: false,
  });
  const cursor = query.data?.pages.at(-1)?.cursor;
  useEffect(() => {
    if (cursor === undefined || cursor >= revision || query.isFetching || query.isError) return;
    // Refresh the loaded pages together so late classification cannot leave a
    // detail in both its old and new Activity. Keep the current content visible.
    const timer = setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey, exact: true }, { cancelRefetch: false });
    }, 300);
    return () => clearTimeout(timer);
  }, [taskId, itemKey, cursor, revision, query.isFetching, query.isError]);
  const items = new Map<number, ConversationItem>();
  for (const page of query.data?.pages ?? []) for (const item of page.items) {
    if ((items.get(item.key)?.revision ?? -1) <= item.revision) items.set(item.key, item);
  }
  return { ...query, items: [...items.values()].sort((a, b) => a.key - b.key) };
}
