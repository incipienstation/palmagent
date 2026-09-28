import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Repo } from "@palmagent/shared";
import { reposQueryOptions } from "../client-queries";

// Shared repoId → Repo lookup for task cards and repo pickers. One query key
// keeps all screens on the same bounded, session-scoped server snapshot.
export function useRepos(): {
  repos: Map<string, Repo>;
  refresh: () => Promise<Repo[]>;
  loading: boolean;
  refreshing: boolean;
  loaded: boolean;
  error: string;
} {
  const query = useQuery(reposQueryOptions());
  const repos = useMemo(() => new Map((query.data ?? []).map((repo) => [repo.id, repo])), [query.data]);
  const refresh = useCallback(async () => {
    const result = await query.refetch();
    if (result.error) throw result.error;
    return result.data ?? [];
  }, [query.refetch]);
  const error = query.error instanceof Error ? query.error.message : query.error ? "Could not load Spaces." : "";

  return {
    repos,
    refresh,
    loading: query.isPending && query.isFetching,
    refreshing: query.isFetching,
    loaded: query.data !== undefined,
    error: error && query.data !== undefined ? `Couldn't refresh Spaces. ${error}` : error,
  };
}
