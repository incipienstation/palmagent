import { QueryClient } from "@tanstack/react-query";
import { onCacheSessionReset } from "./read-cache";

export const TASK_HISTORY_GC_TIME = 5 * 60_000;
const MAX_INACTIVE_TASKS = 5;
const MAX_INACTIVE_BYTES = 4_000_000;
const HISTORY_KEY = "task-history";

export const taskHistoryKey = (taskId: string) => [HISTORY_KEY, taskId] as const;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      gcTime: TASK_HISTORY_GC_TIME,
      retry: false,
      refetchOnMount: false,
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
    },
  },
});

type HistoryData = { pages: Array<{ items?: unknown[] }>; pageParams: unknown[] };
type InactiveEntry = { key: readonly unknown[]; hash: string; data: HistoryData; usedAt: number; size: number };
const lastUsed = new Map<string, number>();
let pruneQueued = false;
let pruning = false;

function byteSize(value: unknown): number {
  try { return JSON.stringify(value).length * 2; }
  catch { return Number.POSITIVE_INFINITY; }
}

function historyQueries() {
  return queryClient.getQueryCache().getAll().filter((query) => query.queryKey[0] === HISTORY_KEY);
}

function schedulePrune(): void {
  if (pruning || pruneQueued) return;
  pruneQueued = true;
  setTimeout(() => {
    pruneQueued = false;
    pruneInactiveHistory();
  }, 0);
}

function pruneInactiveHistory(): void {
  pruning = true;
  try {
    const entries: InactiveEntry[] = historyQueries()
      .filter((query) => query.getObserversCount() === 0 && query.state.data !== undefined)
      .map((query) => {
        const data = query.state.data as HistoryData;
        return {
          key: query.queryKey,
          hash: query.queryHash,
          data,
          usedAt: Math.max(lastUsed.get(query.queryHash) ?? 0, query.state.dataUpdatedAt),
          size: byteSize(data),
        };
      })
      .sort((a, b) => a.usedAt - b.usedAt);

    // Trim old pages from an oversized inactive chat first. The latest page
    // remains the SSE resume point; its `before` cursor still loads older rows.
    for (const entry of entries) {
      let pages = entry.data.pages;
      let pageParams = entry.data.pageParams;
      let size = entry.size;
      while (size > MAX_INACTIVE_BYTES && pages.length > 1) {
        pages = pages.slice(1);
        pageParams = pageParams.slice(1);
        const next = { ...entry.data, pages, pageParams };
        queryClient.setQueryData(entry.key, next);
        size = byteSize(next);
      }
      entry.size = size;
      entry.data = { ...entry.data, pages, pageParams };
      if (size > MAX_INACTIVE_BYTES) queryClient.removeQueries({ queryKey: entry.key, exact: true });
    }

    const retained = entries.filter((entry) => entry.size <= MAX_INACTIVE_BYTES && historyQueries()
      .some((query) => query.queryHash === entry.hash && query.state.data !== undefined));
    let total = retained.reduce((sum, entry) => sum + entry.size, 0);
    while (retained.length > MAX_INACTIVE_TASKS || total > MAX_INACTIVE_BYTES) {
      const oldest = retained.shift()!;
      total -= oldest.size;
      queryClient.removeQueries({ queryKey: oldest.key, exact: true });
      lastUsed.delete(oldest.hash);
    }
  } finally {
    pruning = false;
  }
}

queryClient.getQueryCache().subscribe((event) => {
  if (event.type === "observerAdded" && event.query.queryKey[0] === HISTORY_KEY) {
    lastUsed.set(event.query.queryHash, Date.now());
  } else if (event.type === "removed") {
    lastUsed.delete(event.query.queryHash);
  }
  if (event.query.queryKey[0] === HISTORY_KEY && (event.type === "observerRemoved" || event.type === "updated")) {
    schedulePrune();
  }
});

onCacheSessionReset(() => {
  queryClient.clear();
  lastUsed.clear();
});
