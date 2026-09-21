import { request } from "node:http";
import { lstatSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { CreateRoutineSchema, UpdateRoutineSchema } from "@palmagent/shared/requests";
import { loadConfig, resolveDataDir } from "./config.js";
import { sessionSocket } from "../session-control.js";

export const routineHelp = `Usage: palmagent routine <action> [id] [options]

  spaces                  List registered spaces and scheduler timezone
  list                    List routines
  get <id>                Read a routine
  create --file <json>    Create an agent or script routine
  update <id> --file <json>  Patch a routine (execution kind is fixed)
  enable <id> | disable <id>  Change scheduled execution
  run <id>                Run now, leaving the schedule unchanged
  stop <id>               Stop the current script and its child processes
  runs <id>               Read recent execution results and script output
  delete <id>             Delete a routine and its history

Options:
  --file <path|->          JSON input file, or - for standard input
  --dry-run               Validate create/update JSON without saving
  --data-dir <path>        Select an installed instance
  --help                  Show this help

All results are JSON. Run as the installation owner with the server running.
Agent input: {repoId, agent, prompt, preset, ...}
Script input: {repoId, kind:"script", script:{command, timeoutSeconds:300}, preset, ...}
Cadence: hourly, daily, weekly, weekdays, manual, custom (requires schedule cron).
Optional fields: title, enabled, hour (0-23), dayOfWeek (0-6).
Schedules use the server timezone returned by spaces. Scripts use /bin/sh in an
isolated Git worktree (registered plain folders run in place). No AI call is made.
Scripts run with the installation owner's permissions; timeout is 1-3600 seconds.
Create does not run immediately. Use run only when execution is requested.`;

export async function routineCommand(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({ args, strict: true, allowPositionals: true, options: {
    "data-dir": { type: "string" }, file: { type: "string" }, "dry-run": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help) { console.log(routineHelp); return; }
  const [action, id] = positionals;
  const noId = ["spaces", "list", "create"].includes(action);
  if (positionals.length > 2 || !["spaces", "list", "get", "create", "update", "enable", "disable", "run", "stop", "runs", "delete"].includes(action) ||
      (noId ? !!id : !id) || (values.file && !["create", "update"].includes(action)) ||
      (values["dry-run"] && !["create", "update"].includes(action))) throw new Error(routineHelp);
  let body: unknown;
  if (["create", "update"].includes(action)) {
    if (!values.file) throw new Error("--file is required (use - to read JSON from stdin)");
    const data = JSON.parse(readFileSync(values.file === "-" ? 0 : values.file, "utf8"));
    body = (action === "create" ? CreateRoutineSchema : UpdateRoutineSchema).parse(data);
    if (values["dry-run"]) { console.log(JSON.stringify({ dryRun: true, input: body })); return; }
  }
  if (action === "enable" || action === "disable") body = { enabled: action === "enable" };
  const cfg = loadConfig({ dataDir: resolveDataDir(values["data-dir"]), requireInstalled: true });
  const path = sessionSocket(dirname(cfg.dbPath));
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error("Unsafe installation control socket");
  const route = action === "spaces" ? "/routine-spaces" : "/routines" + (id ? "/" + encodeURIComponent(id) : "") + (["run", "stop", "runs"].includes(action) ? "/" + action : "");
  const method = ["create", "run", "stop"].includes(action) ? "POST" : ["update", "enable", "disable"].includes(action) ? "PATCH" : action === "delete" ? "DELETE" : "GET";
  const result = await new Promise<unknown>((resolve, reject) => {
    const req = request({ socketPath: path, path: route, method, headers: { "content-type": "application/json" }, timeout: 15_000 }, res => {
      let data = "";
      res.on("data", chunk => { data += chunk; if (data.length > 2_000_000) req.destroy(new Error("Response too large")); });
      res.on("end", () => {
        try { const value = JSON.parse(data); if ((res.statusCode ?? 500) >= 400) reject(new Error(value.error ?? "Routine request failed")); else resolve(value); }
        catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Routine request timed out")));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  console.log(JSON.stringify(result, null, 2));
}
