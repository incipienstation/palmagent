import { queryOptions } from "@tanstack/react-query";
import type { SkillContext } from "@palmagent/shared";
import { api } from "./api";
import { clientReadKeys } from "./client-query-keys";

const FIVE_MINUTES = 5 * 60_000;

export const reposQueryOptions = () => queryOptions({
  queryKey: clientReadKeys.repos(),
  queryFn: ({ signal }) => api.listRepos(signal),
  staleTime: 30_000,
  gcTime: FIVE_MINUTES,
  retry: false,
});

export const modelCatalogQueryOptions = () => queryOptions({
  queryKey: clientReadKeys.modelCatalog(),
  queryFn: ({ signal }) => api.modelCatalog(signal),
  staleTime: FIVE_MINUTES,
  gcTime: FIVE_MINUTES,
  retry: false,
});

export const usageQueryOptions = () => queryOptions({
  queryKey: clientReadKeys.usage(),
  queryFn: ({ signal }) => api.getUsage(signal),
  staleTime: 10_000,
  gcTime: FIVE_MINUTES,
  retry: false,
});

export const routinesQueryOptions = () => queryOptions({
  queryKey: clientReadKeys.routines(),
  queryFn: ({ signal }) => api.listRoutines(signal),
  staleTime: 30_000,
  gcTime: FIVE_MINUTES,
  retry: false,
});

export const routineRunsQueryOptions = (routineId: string, kind: "agent" | "script") => queryOptions({
  queryKey: clientReadKeys.routineRuns(routineId, kind),
  queryFn: ({ signal }) => api.routineRuns(routineId, signal),
  staleTime: kind === "script" ? 0 : 10_000,
  gcTime: FIVE_MINUTES,
  retry: false,
  refetchInterval: (query) => query.state.data?.some((run) => run.status === "running") ? 3_000 : false,
});

export const skillsQueryOptions = (context?: SkillContext) => queryOptions({
  queryKey: clientReadKeys.skills(context ?? null),
  queryFn: ({ signal }) => {
    if (!context) throw new Error("Skill context is required.");
    return api.skills(context, signal);
  },
  staleTime: 10_000,
  gcTime: 60_000,
  retry: false,
});
