import { TaskReadHttpSettingsSchema, TaskReadHttpStatusSchema, type TaskReadHttpSettings } from "@palmagent/shared";
import { applicationRequest } from "../../../../platform/ipc/application-runtime.js";

/** Startup/shutdown control only. No browser request passes through this adapter. */
export class NativeReadHttp {
  constructor(private readonly dataDir: string) {}
  async configure(settings: TaskReadHttpSettings | null): Promise<void> {
    const input = settings === null ? null : TaskReadHttpSettingsSchema.parse(settings);
    const response = await applicationRequest(this.dataDir, "/v1/task-reads/http", "POST", input);
    if (response.status !== 200) throw new Error("Native read HTTP listener could not be configured");
    const status = TaskReadHttpStatusSchema.parse(response.value);
    if (status.enabled !== (settings !== null) || settings && settings.port !== 0 && status.port !== settings.port) {
      throw new Error("Native read HTTP listener did not accept the requested configuration");
    }
  }
}
