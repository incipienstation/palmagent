import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { clientReadKeys } from "../client-query-keys";

export function useTaskFile(taskId: string, path: string) {
  return useQuery({
    queryKey: [...clientReadKeys.all, "task-file", taskId, path],
    queryFn: ({ signal }) => api.taskFile(taskId, path, signal),
    gcTime: 0, staleTime: 0, retry: false,
  });
}
