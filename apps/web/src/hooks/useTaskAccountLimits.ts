import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { clientReadKeys } from "../client-query-keys";
import { useReadStream } from "./useReadStream";

export function useTaskAccountLimits(taskId: string) {
  const queryKey = clientReadKeys.taskLimits(taskId);
  const query = useQuery({ queryKey, queryFn: () => api.getAccountLimits(taskId),
    staleTime: 300_000, retry: false });
  useReadStream(`/api/tasks/${encodeURIComponent(taskId)}/account-limits/stream`, queryKey);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    // Local countdown only. Account reads are driven by the stream.
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 30_000);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, []);
  return { report: query.isError ? null : query.data ?? null, failed: query.isError, now };
}
