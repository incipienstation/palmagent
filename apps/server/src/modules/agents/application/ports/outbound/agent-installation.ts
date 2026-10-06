import type { AgentInstallation, AgentKind } from "@palmagent/shared";
export type InstalledAgent = Pick<AgentInstallation, "version" | "installation"> & { command?: string };
export type AgentUpdateRecords = Partial<Record<AgentKind, AgentInstallation["update"]>>;
export interface AgentInstallationHost {
  inspect(agent: AgentKind, home: string): Promise<InstalledAgent>;
  latest(agent: AgentKind): Promise<string>;
  update(agent: AgentKind, home: string, installed: InstalledAgent): Promise<void>;
  now(): number;
  lock(): () => void;
  readUpdates(): AgentUpdateRecords;
  writeUpdates(records: AgentUpdateRecords): void;
}
