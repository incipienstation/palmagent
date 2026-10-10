import { useEffect } from "react";
import type { QueryKey } from "@tanstack/react-query";
import { connectSse } from "./sse";
import { refreshClientReads } from "../query-client";

export function useReadStream(url: string | undefined, queryKey: QueryKey): void {
  const key = JSON.stringify(queryKey);
  useEffect(() => {
    if (!url) return;
    const connection = connectSse(url, event => {
      // Foreground reconnect supplies a fresh invalidation for changes missed while hidden.
      if (document.visibilityState === "hidden") return;
      try {
        if (JSON.parse(event.data).type === "read-change") void refreshClientReads(JSON.parse(key));
      } catch { /* Ignore malformed frames. */ }
    }, () => {});
    return () => connection.close();
  }, [url, key]);
}
