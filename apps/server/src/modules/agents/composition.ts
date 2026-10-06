import type { AgentKind } from "@palmagent/shared";
import type { AgentInstallationHost } from "./application/ports/outbound/agent-installation.js";
import { AgentInstallationService } from "./application/use-cases/agent-installations.js";
import { nativeInstallationDependencies } from "./adapters/outbound/agent-installations.js";

export function createAgentInstallationService(home: (agent: AgentKind) => string, overrides: Partial<AgentInstallationHost> = {}, dataDir?: string) {
  return new AgentInstallationService(home, { ...nativeInstallationDependencies(dataDir), ...overrides });
}
