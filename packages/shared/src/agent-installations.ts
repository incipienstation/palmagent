import type { AgentKind } from "./events.js";

export interface AgentInstallation {
  agent: AgentKind;
  version: string | null;
  installation: "native" | "external" | "missing" | "unavailable";
  compatible: boolean | null;
  latestVersion: string | null;
  latestCompatible: boolean | null;
  checkedAt: number;
  releaseState: "ready" | "error";
  update: { state: "idle" | "running" | "succeeded" | "failed"; message?: string };
}

export interface AgentInstallationsResponse {
  installations: AgentInstallation[];
  canUpdate: boolean;
}
