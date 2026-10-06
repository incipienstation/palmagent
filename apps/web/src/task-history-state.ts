import type { UseInfiniteQueryResult } from "@tanstack/react-query";

type HistoryError = { status: "error"; message: string };
export type InitialHistoryState = { status: "disabled" | "loading" | "paused" | "ready" } | HistoryError;
export type EarlierHistoryState = { hasMore: boolean } & (
  { status: "unavailable" | "idle" | "loading" | "paused" } | HistoryError
);
export interface TaskHistoryState {
  initial: InitialHistoryState;
  earlier: EarlierHistoryState;
}
export interface TaskHistoryControls extends TaskHistoryState {
  retryInitial: () => void;
  loadEarlier: () => void;
}

type HistoryQueryState = Pick<UseInfiniteQueryResult,
  "data" | "isFetching" | "isPaused" | "isError" | "error" | "isPlaceholderData" |
  "hasPreviousPage" | "isFetchingPreviousPage" | "isFetchPreviousPageError"
>;

// Translate query state once. Paused requests are waiting for connectivity,
// and retained data stays ready even when a different output mode is loading.
export function taskHistoryState(query: HistoryQueryState, enabled: boolean): TaskHistoryState {
  const initial: InitialHistoryState = !enabled ? { status: "disabled" }
    : query.data ? { status: "ready" }
    : query.isPaused ? { status: "paused" }
    : query.isFetching ? { status: "loading" }
    : query.isError ? { status: "error", message: query.error?.message ?? "Could not load conversation history." }
    : { status: "loading" };
  const hasMore = enabled && !!query.data && query.hasPreviousPage;
  const earlier: EarlierHistoryState = !hasMore || query.isPlaceholderData ? { status: "unavailable", hasMore }
    : query.isPaused ? { status: "paused", hasMore }
    : query.isFetchingPreviousPage ? { status: "loading", hasMore }
    : query.isFetchPreviousPageError ? { status: "error", hasMore, message: query.error?.message ?? "Could not load earlier messages." }
    : { status: "idle", hasMore };
  return { initial, earlier };
}
