import { parseArgs } from "node:util";
import { UpdateSettingsChangeSchema, type UpdateSettingsChange, type UpdateSettingsCommandResult } from "@palmagent/shared/updates";
import type { UpdateSettingsCommand, UpdateSettingsCommands } from "../../application/ports/inbound/update-settings-command.js";

export function createUpdateSettingsCommand(service: UpdateSettingsCommands) {
  return async (args: string[]): Promise<UpdateSettingsCommandResult> => {
    let action = "status", changing = false;
    try {
      const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {
        "data-dir": { type: "string" }, "expected-db": { type: "string" },
        channel: { type: "string" }, "auto-update": { type: "string" }, target: { type: "string" },
      } });
      if (positionals.length !== 1 || !["status", "set", "visit", "check", "install", "migrate", "resume"].includes(positionals[0]) || !values["data-dir"] || !values["expected-db"]) {
        throw new Error("invalid update settings command");
      }
      action = positionals[0];
      changing = action !== "status";
      if ((action === "install") !== (values.target !== undefined)) throw new Error("invalid update target");
      let change: UpdateSettingsChange | undefined;
      if (action === "set") {
        change = UpdateSettingsChangeSchema.parse({
          ...(values.channel !== undefined ? { channel: values.channel } : {}),
          ...(values["auto-update"] !== undefined ? { autoUpdate: values["auto-update"] === "true" ? true : values["auto-update"] === "false" ? false : values["auto-update"] } : {}),
        });
      } else if (values.channel !== undefined || values["auto-update"] !== undefined) throw new Error("status cannot change preferences");
      const target = { dataDir: values["data-dir"], expectedDb: values["expected-db"] };
      const command: UpdateSettingsCommand = action === "set" ? { ...target, action, change: change! }
        : action === "install" ? { ...target, action, target: values.target! }
        : { ...target, action: action as "status" | "visit" | "check" | "migrate" | "resume" };
      return await service.execute(command);
    } catch {
      return { ok: false, error: action === "set" ? "save-failed" : changing ? "update-failed" : "unavailable" };
    }
  };
}
