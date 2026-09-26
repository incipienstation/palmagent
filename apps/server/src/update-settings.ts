import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { UpdateActionSchema, type UpdateAction, UpdateSettingsChangeSchema, UpdateSettingsCommandResultSchema, type UpdateSettingsChange, type UpdateSettingsState } from "@palmagent/shared/updates";
import { ApplicationError } from "./errors.js";

export interface UpdateSettingsService {
  status(): Promise<UpdateSettingsState>;
  change(change: UpdateSettingsChange): Promise<UpdateSettingsState>;
  action(action: UpdateAction): Promise<UpdateSettingsState>;
  resume(): Promise<UpdateSettingsState>;
}

const execute = promisify(execFile);
const unavailable = (availability: UpdateSettingsState["availability"]): UpdateSettingsState => ({ availability, settings: null });

/** Host changes stay in the installed CLI. Requests cannot select an executable,
 * path or shell command. An install request must match the checked version. The updater runs in systemd,
 * so a later web restart does not kill it with the web service's cgroup. */
export function createUpdateSettingsService(options: { packageDir?: string; dataDir: string; dbPath: string }): UpdateSettingsService {
  async function command(change?: UpdateSettingsChange, action?: UpdateAction | { action: "resume" }): Promise<UpdateSettingsState> {
    const mutating = Boolean(change || action);
    if (!options.packageDir) {
      if (mutating) throw new ApplicationError("conflict", "Update settings require an installed Palmagent package.");
      return unavailable("source-install");
    }
    const args = [join(options.packageDir, "cli.js"), "update-settings", change ? "set" : action?.action ?? "status",
      "--data-dir", options.dataDir, "--expected-db", options.dbPath];
    if (change) {
      const input = UpdateSettingsChangeSchema.parse(change);
      args.push(...("channel" in input ? ["--channel", input.channel] : ["--auto-update", String(input.autoUpdate)]));
    }
    if (action?.action === "install") args.push("--target", action.version);
    let response;
    try {
      const { stdout } = await execute(process.execPath, args, {
        timeout: 60_000, maxBuffer: 64 * 1024,
        env: { ...process.env, PALMAGENT_NON_INTERACTIVE: "1" },
      });
      response = UpdateSettingsCommandResultSchema.parse(JSON.parse(stdout));
    } catch {
      // Never forward subprocess stderr, command arguments, or private paths.
      if (!mutating) return unavailable("unavailable");
      throw new ApplicationError("service_unavailable", "Could not confirm the update setting. Refresh its status before trying again.");
    }
    if (!response.ok) {
      if (!mutating) return unavailable("unavailable");
      if (response.error === "busy") throw new ApplicationError("conflict", "An installation or update is in progress. Try again after it finishes.");
      if (response.error === "stale-update") throw new ApplicationError("conflict", "This update is no longer available or needs recovery. Check again before updating.");
      if (response.error === "update-failed") throw new ApplicationError("service_unavailable", "Could not complete the update request. Check its status before trying again.");
      throw new ApplicationError("service_unavailable", response.error === "unavailable"
        ? "Update settings are unavailable for this installation. Refresh its status."
        : "Could not save the update setting. Refresh its status before trying again.");
    }
    return response.state;
  }
  // Serialize local requests; the CLI lock also excludes other host processes.
  let tail: Promise<unknown> = Promise.resolve();
  function enqueue(work: () => Promise<UpdateSettingsState>) {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  }
  let visit: Promise<UpdateSettingsState> | undefined;
  return {
    status: () => enqueue(() => command()),
    change: (change) => enqueue(() => command(UpdateSettingsChangeSchema.parse(change))),
    action: (action) => {
      const input = UpdateActionSchema.parse(action);
      if (input.action !== "visit") return enqueue(() => command(undefined, input));
      return visit ??= enqueue(() => command(undefined, input)).finally(() => { visit = undefined; });
    },
    resume: () => enqueue(() => command(undefined, { action: "resume" })),
  };
}
