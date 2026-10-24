import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { CreateRoutineRequest, Routine, RoutineRun, UpdateRoutineRequest } from "@palmagent/shared";
import { DaemonStatusSchema, DaemonHostStateSchema } from "@palmagent/shared/daemon";
import { ApplicationError } from "../../../../kernel/errors.js";
import { applicationRequest } from "../../../../platform/ipc/application-runtime.js";
import { daemonRequest } from "../../../../platform/process/daemon-client.js";
import type { ScriptRuntime } from "../../application/ports/outbound/script-runtime.js";

const Status = z.object({ protocol: z.literal(1), version: z.string(), sourceCommit: z.string(), instance: z.string().min(1),
  revision: z.number().int().nonnegative(), activeScripts: z.number().int().nonnegative(), stopping: z.boolean() });

export class NativeScriptRuntime implements ScriptRuntime {
  private expected?: { version: string; sourceCommit: string };
  constructor(private readonly dataDir: string) {}
  async connect(release: string) {
    const manifest = JSON.parse(readFileSync(join(release, "daemon/manifest.json"), "utf8"));
    if (manifest.applicationRuntime !== 1) throw new Error("This release does not include the application runtime");
    this.expected = { version: manifest.version, sourceCommit: manifest.sourceCommit };
    const status = DaemonStatusSchema.parse(await daemonRequest(this.dataDir, { action: "status" }));
    if (status.applicationRuntime !== 1) throw new Error("The daemon must be updated before starting this application runtime");
    const state = DaemonHostStateSchema.parse(await daemonRequest(this.dataDir, { action: "start-application", release }));
    if (!state.alive || !["ready", "pending"].includes(state.lifecycle?.readiness ?? "")) throw new Error("Application startup was not confirmed");
    const deadline = Date.now() + 55_000;
    for (;;) {
      try { await this.status(); return; }
      catch (error) {
        if (Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }
  private async call<T>(path: string, method = "GET", input?: unknown): Promise<T> {
    let result: Awaited<ReturnType<typeof applicationRequest>>;
    try { result = await applicationRequest(this.dataDir, path, method, input); }
    catch { throw new ApplicationError("service_unavailable", "Script scheduler is unavailable; request delivery is unconfirmed"); }
    if (result.status >= 400) {
      const code = result.status === 400 ? "bad_request" : result.status === 404 ? "not_found" : result.status === 409 ? "conflict" : "service_unavailable";
      const message = z.object({ error: z.string() }).safeParse(result.value);
      throw new ApplicationError(code, message.success ? message.data.error : "Script scheduler is unavailable");
    }
    return result.value as T;
  }
  async status() {
    const status = Status.parse(await this.call("/health"));
    if (status.stopping || this.expected && (status.version !== this.expected.version || status.sourceCommit !== this.expected.sourceCommit)) {
      throw new ApplicationError("service_unavailable", "Application runtime identity changed");
    }
    return status;
  }
  private path(id: string) { return `/v1/routines/${encodeURIComponent(id)}`; }
  async list() { return (await this.call<{ routines: Routine[] }>("/v1/routines")).routines; }
  async get(id: string) { return (await this.call<{ routine: Routine }>(this.path(id))).routine; }
  async create(input: CreateRoutineRequest) { return (await this.call<{ routine: Routine }>("/v1/routines", "POST", input)).routine; }
  async update(id: string, input: UpdateRoutineRequest) { return (await this.call<{ routine: Routine }>(this.path(id), "PATCH", input)).routine; }
  async remove(id: string) { return (await this.call<{ routine: Routine }>(this.path(id), "DELETE")).routine; }
  async run(id: string) { return (await this.call<{ routine: Routine }>(`${this.path(id)}/run`, "POST")).routine; }
  async stop(id: string) { return (await this.call<{ routine: Routine }>(`${this.path(id)}/stop`, "POST")).routine; }
  async runs(id: string) { return (await this.call<{ runs: RoutineRun[] }>(`${this.path(id)}/runs`)).runs; }
}
