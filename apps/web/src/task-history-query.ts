import { onCacheSessionReset } from "./query-lifecycle";
import { queryClient } from "./query-client";

export const TASK_HISTORY_GC_TIME = 5 * 60_000;
export const TASK_ACTIVITY_DETAILS_GC_TIME = 60_000;
const MAX_INACTIVE_TASKS = 5;
const MAX_INACTIVE_BYTES = 4_000_000;
const MAX_INACTIVE_ACTIVITY_DETAILS = 3;
const MAX_INACTIVE_ACTIVITY_BYTES = 2_000_000;
const HISTORY_KEY = "task-history";
const ACTIVITY_DETAILS_KEY = "task-activity-details";

export const taskHistoryKey = (taskId: string, mode: "compact" | "verbose" = "compact") =>
  mode === "compact" ? [HISTORY_KEY, taskId] as const : [HISTORY_KEY, taskId, "full"] as const;
// `from` identifies one Activity; its `through` watermark advances while live
// and is refreshed into the same cache entry when the Activity grows.
export const taskActivityDetailsKey = (taskId: string, from: number) =>
  [ACTIVITY_DETAILS_KEY, taskId, from] as const;

export { queryClient };

type HistoryData = { pages: Array<{ items?: unknown[] }>; pageParams: unknown[] };
type InactiveEntry = { key: readonly unknown[]; hash: string; data: HistoryData; taskId: string; usedAt: number; size: number };
type InactiveDetailsEntry = { key: readonly unknown[]; hash: string; usedAt: number; size: number };
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

function activityDetailsQueries() {
  return queryClient.getQueryCache().getAll().filter((query) => query.queryKey[0] === ACTIVITY_DETAILS_KEY);
}

function schedulePrune(): void {
  if (pruning || pruneQueued) return;
  pruneQueued = true;
  setTimeout(() => {
    pruneQueued = false;
    pruneInactiveCaches();
  }, 0);
}

function pruneInactiveCaches(): void {
  pruning = true;
  try {
    pruneInactiveHistory();
    pruneInactiveActivityDetails();
  } finally {
    pruning = false;
  }
}

function pruneInactiveHistory(): void {
  const entries: InactiveEntry[] = historyQueries()
    .filter((query) => query.getObserversCount() === 0 && query.state.data !== undefined)
    .map((query) => ({
      key: query.queryKey,
      hash: query.queryHash,
      data: query.state.data as HistoryData,
      taskId: String(query.queryKey[1]),
      usedAt: Math.max(lastUsed.get(query.queryHash) ?? 0, query.state.dataUpdatedAt),
      size: byteSize(query.state.data),
    }))
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

  const grouped = new Map<string, InactiveEntry[]>();
  for (const entry of entries) {
    if (!historyQueries().some((query) => query.queryHash === entry.hash && query.state.data !== undefined)) continue;
    const group = grouped.get(entry.taskId) ?? [];
    group.push(entry);
    grouped.set(entry.taskId, group);
  }
  const retained = [...grouped.entries()].map(([taskId, groupEntries]) => ({
    taskId,
    entries: groupEntries.sort((a, b) => a.usedAt - b.usedAt),
    usedAt: Math.max(...groupEntries.map((entry) => entry.usedAt)),
    size: groupEntries.reduce((sum, entry) => sum + entry.size, 0),
  })).sort((a, b) => a.usedAt - b.usedAt);

  // Compact and verbose variants share the same per-task memory allowance.
  for (const task of retained) {
    while (task.size > MAX_INACTIVE_BYTES && task.entries.length > 1) {
      const oldest = task.entries.shift()!;
      task.size -= oldest.size;
      queryClient.removeQueries({ queryKey: oldest.key, exact: true });
      lastUsed.delete(oldest.hash);
    }
  }
  let total = retained.reduce((sum, task) => sum + task.size, 0);
  while (retained.length > MAX_INACTIVE_TASKS || total > MAX_INACTIVE_BYTES) {
    const oldest = retained.shift()!;
    total -= oldest.size;
    for (const entry of oldest.entries) {
      queryClient.removeQueries({ queryKey: entry.key, exact: true });
      lastUsed.delete(entry.hash);
    }
  }
}

function pruneInactiveActivityDetails(): void {
  const entries: InactiveDetailsEntry[] = activityDetailsQueries()
    .filter((query) => query.getObserversCount() === 0 && query.state.data !== undefined)
    .map((query) => ({
      key: query.queryKey,
      hash: query.queryHash,
      usedAt: Math.max(lastUsed.get(query.queryHash) ?? 0, query.state.dataUpdatedAt),
      size: byteSize(query.state.data),
    }))
    .sort((a, b) => a.usedAt - b.usedAt);

  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  while (entries.length > MAX_INACTIVE_ACTIVITY_DETAILS || total > MAX_INACTIVE_ACTIVITY_BYTES) {
    const oldest = entries.shift()!;
    total -= oldest.size;
    queryClient.removeQueries({ queryKey: oldest.key, exact: true });
    lastUsed.delete(oldest.hash);
  }
}

queryClient.getQueryCache().subscribe((event) => {
  const key = event.query.queryKey[0];
  if (event.type === "observerAdded" && (key === HISTORY_KEY || key === ACTIVITY_DETAILS_KEY)) {
    lastUsed.set(event.query.queryHash, Date.now());
  } else if (event.type === "removed") {
    lastUsed.delete(event.query.queryHash);
  }
  if ((key === HISTORY_KEY || key === ACTIVITY_DETAILS_KEY) && (event.type === "observerRemoved" || event.type === "updated")) {
    schedulePrune();
  }
});

onCacheSessionReset(() => {
  queryClient.clear();
  lastUsed.clear();
});
