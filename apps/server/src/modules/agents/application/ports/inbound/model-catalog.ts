import type { AgentKind, AgentModelCatalog } from "@palmagent/shared";

/** Operations accepted by the agents module. */
export interface ModelCatalog {
  get(agent: AgentKind, home: string): Promise<AgentModelCatalog>;
}
