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

  return {
    repos,
    refresh,
    loading: query.isPending && query.isFetching,
    loaded: query.data !== undefined,
    error: query.data === undefined
      ? query.error instanceof Error ? query.error.message : query.error ? "Could not load repositories." : ""
      : "",
  };
}
