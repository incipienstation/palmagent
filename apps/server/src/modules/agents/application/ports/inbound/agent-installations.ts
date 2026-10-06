import type { AgentInstallation, AgentKind } from "@palmagent/shared";

/** Operations accepted by the agents module. */
export interface AgentInstallations {
  list(): Promise<AgentInstallation[]>;
  get(agent: AgentKind): Promise<AgentInstallation>;
  update(agent: AgentKind, expectedVersion: string): Promise<AgentInstallation>;
  close(): Promise<void>;
}
