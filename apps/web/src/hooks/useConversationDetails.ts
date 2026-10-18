import { useQuery } from "@tanstack/react-query";
import type { ConversationContentRef, TranscriptRow } from "@palmagent/shared";
import { api } from "../api";
import { taskActivityDetailsKey, TASK_ACTIVITY_DETAILS_GC_TIME } from "../task-history-query";

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
