import type { AgentKind, SkillContext } from "@palmagent/shared";

export const clientReadKeys = {
  all: ["client-read"] as const,
  repos: () => [...clientReadKeys.all, "repos"] as const,
  modelCatalog: () => [...clientReadKeys.all, "model-catalog"] as const,
  agents: () => [...clientReadKeys.all, "agents"] as const,
  agentInstallations: () => [...clientReadKeys.agents(), "installations"] as const,
  taskLimits: (taskId: string) => [...clientReadKeys.all, "task-limits", taskId] as const,
  agentLimits: (agent: AgentKind) => [...clientReadKeys.agents(), "limits", agent] as const,
  usage: () => [...clientReadKeys.all, "usage"] as const,
  routines: () => [...clientReadKeys.all, "routines"] as const,
  routineRuns: (routineId: string, kind: "agent" | "script") =>
    [...clientReadKeys.all, "routine-runs", routineId, kind] as const,
  routineRunsFor: (routineId: string) => [...clientReadKeys.all, "routine-runs", routineId] as const,
  routineRunsAll: () => [...clientReadKeys.all, "routine-runs"] as const,
  skills: (context: SkillContext | null) => [...clientReadKeys.all, "skills", context] as const,
};
