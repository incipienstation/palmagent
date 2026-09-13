import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { UpdateSettingsChangeSchema, UpdateSettingsCommandResultSchema, type UpdateSettingsChange, type UpdateSettingsState } from "@palmagent/shared/updates";
import { HttpError } from "./service.js";

export interface UpdateSettingsService {
  status(): Promise<UpdateSettingsState>;
  change(change: UpdateSettingsChange): Promise<UpdateSettingsState>;
}

const execute = promisify(execFile);
const unavailable = (availability: UpdateSettingsState["availability"]): UpdateSettingsState => ({ availability, settings: null });

/** Host changes stay in the installed CLI. Requests cannot select an executable,
 * path, version, shell command, or install operation. The updater runs in systemd,
 * so a later web restart does not kill it with the web service's cgroup. */
export function createUpdateSettingsService(options: { packageDir?: string; dataDir: string; dbPath: string }): UpdateSettingsService {
  async function command(change?: UpdateSettingsChange): Promise<UpdateSettingsState> {
    if (!options.packageDir) {
      if (change) throw new HttpError(409, "Update settings require an installed Palmagent package.");
      return unavailable("source-install");
    }
    const args = [join(options.packageDir, "cli.js"), "update-settings", change ? "set" : "status",
      "--data-dir", options.dataDir, "--expected-db", options.dbPath];
    if (change) {
      const input = UpdateSettingsChangeSchema.parse(change);
      args.push(...("channel" in input ? ["--channel", input.channel] : ["--auto-update", String(input.autoUpdate)]));
    }
    let response;
    try {
      const { stdout } = await execute(process.execPath, args, {
        timeout: 30_000, maxBuffer: 64 * 1024,
        env: { ...process.env, PALMAGENT_NON_INTERACTIVE: "1" },
      });
      response = UpdateSettingsCommandResultSchema.parse(JSON.parse(stdout));
    } catch {
      // Never forward subprocess stderr, command arguments, or private paths.
      if (!change) return unavailable("unavailable");
      throw new HttpError(503, "Could not confirm the update setting. Refresh its status before trying again.");
    }
    if (!response.ok) {
      if (!change) return unavailable("unavailable");
      if (response.error === "busy") throw new HttpError(409, "An installation or update is in progress. Try again after it finishes.");
      throw new HttpError(503, response.error === "unavailable"
        ? "Update settings are unavailable for this installation. Refresh its status."
        : "Could not save the update setting. Refresh its status before trying again.");
    }
    return response.state;
  }
  return { status: () => command(), change: (change) => command(change) };
}
