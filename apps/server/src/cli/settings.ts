import { parseArgs } from "node:util";
import { join } from "node:path";
import { SettingsStore, parseRepoRoots } from "../settings.js";
import { resolveDataDir } from "./config.js";

export const settingsHelp = `Usage: palmagent settings <action> [repo-roots] [paths...] [options]

  get [repo-roots]           Show effective search paths and their source
  set repo-roots [paths...]  Replace paths; no paths disables automatic search
  add repo-roots <paths...>  Add search folders
  remove repo-roots <paths...>  Remove search folders
  reset repo-roots           Restore installation defaults (REPO_ROOTS)

Options:
  --data-dir <path>  Select the installation (use the server's data directory)
  --json            Print the result as JSON
  --dry-run         Validate and preview a change without writing
  --help            Print this help

Run as the installation owner. Paths accept absolute locations or ~/.
Changes apply on the next search, without restarting or removing registered spaces.`;

export function settingsCommand(args: string[]): void {
  const { positionals, values } = parseArgs({ args, strict: true, allowPositionals: true, options: {
    "data-dir": { type: "string" }, json: { type: "boolean" }, "dry-run": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help) { console.log(settingsHelp); return; }
  const [action, key, ...paths] = positionals;
  if (!["get", "set", "add", "remove", "reset"].includes(action) ||
      (action === "get" ? key !== undefined && key !== "repo-roots" : key !== "repo-roots") ||
      (["get", "reset"].includes(action) && paths.length > 0) ||
      (["add", "remove"].includes(action) && paths.length === 0) ||
      (action === "get" && values["dry-run"])) throw new Error(settingsHelp);
  const dataDir = resolveDataDir(values["data-dir"] ?? process.env.DISPATCHER_DATA_DIR ??
    (process.env.XDG_STATE_HOME ? join(process.env.XDG_STATE_HOME, "palmagent") : undefined));
  const store = new SettingsStore(dataDir, parseRepoRoots(process.env.REPO_ROOTS ?? ""));
  const result = action === "get" ? store.get()
    : store.change(action === "reset" ? { action } : { action: action as "set" | "add" | "remove", paths }, values["dry-run"]);
  if (values.json) console.log(JSON.stringify(result));
  else {
    if (values["dry-run"]) console.log("Dry run: no settings were saved.");
    console.log(`Space search paths (${result.source === "saved" ? "saved settings" : "installation defaults"}):`);
    console.log(result.repoRoots.length ? result.repoRoots.map((path) => `  ${path}`).join("\n") : "  Automatic search is off.");
  }
}
