import { TaskActivityDetailsResponseSchema, type TaskActivityDetailsResponse } from "@palmagent/shared";
import { ApplicationError } from "../../../../kernel/errors.js";
import { applicationRequest } from "../../../../platform/ipc/application-runtime.js";
import type { TaskActivityReader } from "../../application/ports/outbound/activity.js";

export class NativeTaskActivity implements TaskActivityReader {
  constructor(private readonly dataDir: string) {}
  async activityDetails(taskId: string, from: number, through: number): Promise<TaskActivityDetailsResponse> {
    try {
      const query = new URLSearchParams({ taskId, from: String(from), through: String(through) });
      // Legacy activity expansion returns the entire requested range, including large tool
      // output. Do not introduce the control transport's 16 MiB truncation at this read boundary.
      const response = await applicationRequest(this.dataDir, `/v1/tasks/activity-details?${query}`, "GET", undefined, { maxResponseBytes: Infinity });
      if (response.status !== 200) throw new Error("Native activity read failed");
      return TaskActivityDetailsResponseSchema.parse(response.value);
    } catch {
      throw new ApplicationError("service_unavailable", "Task activity is temporarily unavailable");
    }
  }
}
