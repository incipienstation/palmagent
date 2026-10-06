import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Users type paths with the shell habit ("~/code/x") — especially on a phone
// keyboard. path.resolve treats "~" literally, so expand it first.
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Shared CLI/runtime state location; resolving never moves an existing installation. */
export function resolveStateDirectory(name: string, requested?: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = requested ?? (env.DISPATCHER_DATA_DIR || undefined);
  return explicit !== undefined ? resolve(expandHome(explicit))
    : env.XDG_STATE_HOME ? join(resolve(expandHome(env.XDG_STATE_HOME)), name)
    : join(homedir(), ".local", "state", name);
}
