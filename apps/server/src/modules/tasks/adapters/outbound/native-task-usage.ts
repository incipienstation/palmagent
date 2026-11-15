import { UsageResponseSchema, type AgentUsage } from "@palmagent/shared";
import { ApplicationError } from "../../../../kernel/errors.js";
import { applicationRequest } from "../../../../platform/ipc/application-runtime.js";
import type { TaskUsageReader } from "../../application/ports/outbound/usage.js";

/** Composition selects this reader only after the native capability/identity handshake. */
export class NativeTaskUsage implements TaskUsageReader {
  constructor(private readonly dataDir: string) {}
  async usageByAgent(): Promise<AgentUsage[]> {
    try {
      const response = await applicationRequest(this.dataDir, "/v1/tasks/usage");
      if (response.status !== 200) throw new Error("Native usage read failed");
      return UsageResponseSchema.parse(response.value).usage;
    } catch {
      // Reads may be retried explicitly. Never switch owners or expose DB/process errors.
      throw new ApplicationError("service_unavailable", "Task usage is temporarily unavailable");
    }
  }
}
