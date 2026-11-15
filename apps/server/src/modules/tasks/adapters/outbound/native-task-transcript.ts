import { TranscriptPageSchema, TranscriptChangesSchema, TranscriptStepsSchema } from "@palmagent/shared";
import { ApplicationError } from "../../../../kernel/errors.js";
import { applicationRequest } from "../../../../platform/ipc/application-runtime.js";
import type { TaskTranscriptReader } from "../../application/ports/outbound/transcript.js";

export class NativeTaskTranscript implements TaskTranscriptReader {
  constructor(private readonly dataDir: string) {}
  async conversationSteps(taskId: string, key: number, after?: number) {
    const query = new URLSearchParams({ taskId, key: String(key) });
    if (after !== undefined) query.set("after", String(after));
    return this.read("steps", query, TranscriptStepsSchema);
  }
  async conversationPage(taskId: string, before?: number) {
    const query = new URLSearchParams({ taskId });
    if (before !== undefined) query.set("before", String(before));
    return this.read("page", query, TranscriptPageSchema);
  }
  async conversationChanges(taskId: string, after: number, through?: number, afterKey?: number) {
    const query = new URLSearchParams({ taskId, after: String(after) });
    if (through !== undefined) query.set("through", String(through));
    if (afterKey !== undefined) query.set("afterKey", String(afterKey));
    return this.read("changes", query, TranscriptChangesSchema);
  }
  private async read<T>(path: string, query: URLSearchParams, schema: { parse(value: unknown): T }): Promise<T> {
    try {
      const response = await applicationRequest(this.dataDir, `/v1/tasks/transcript/${path}?${query}`);
      if (path === "steps" && response.status === 404) throw new ApplicationError("not_found", "Conversation item is no longer available.");
      if (response.status !== 200) throw new Error("Native transcript read failed");
      return schema.parse(response.value);
    } catch (error) {
      if (error instanceof ApplicationError && error.code === "not_found") throw error;
      throw new ApplicationError("service_unavailable", "Task transcript is temporarily unavailable");
    }
  }
}
