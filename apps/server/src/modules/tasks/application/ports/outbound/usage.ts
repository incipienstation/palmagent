import type { AgentUsage } from "@palmagent/shared";

/** Read committed usage totals without acquiring Task execution or write ownership. */
export interface TaskUsageReader {
  usageByAgent(): AgentUsage[] | Promise<AgentUsage[]>;
}
