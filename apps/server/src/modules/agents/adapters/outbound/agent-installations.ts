import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { constants, readFileSync } from "node:fs";
import { z } from "zod";
import { homedir } from "node:os";
import { delimiter, join, resolve, sep } from "node:path";
import type { AgentInstallation, AgentKind } from "@palmagent/shared";
import { writePrivateFileAtomic } from "../../../../platform/filesystem/private-files.js";

const agents = ["claude", "codex"] as const;
const versionPattern = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
const UpdateRecords = z.object({
  claude: z.object({ state: z.enum(["idle", "running", "succeeded", "failed"]), message: z.string().max(300).optional() }).optional(),
  codex: z.object({ state: z.enum(["idle", "running", "succeeded", "failed"]), message: z.string().max(300).optional() }).optional(),
});
import type { InstalledAgent as Installed, AgentInstallationHost } from "../../application/ports/outbound/agent-installation.js";

// Commands and arguments are selected here, never supplied by an HTTP client.
// Discard native diagnostics: they can include private paths and account data.
async function command(file: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, cwd: homedir(), detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"] });
    let output = "", failed = false;
    const stop = () => {
      failed = true;
      try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* already exited */ }
    };
    const timer = setTimeout(stop, timeout);
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.length > 256_000) stop(); });
    child.once("error", () => { clearTimeout(timer); reject(new Error("CLI command unavailable")); });
    child.once("close", code => {
      clearTimeout(timer);
      if (failed || code !== 0) reject(new Error("CLI command failed")); else resolve(output);
    });
  });
}

function environment(agent: AgentKind, home: string): NodeJS.ProcessEnv {
  return { ...process.env, NO_COLOR: "1", DISABLE_AUTOUPDATER: "1", [agent === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]: home };
}

export async function inspectAgentInstallation(agent: AgentKind, home: string): Promise<Installed> {
  let file: string | undefined;
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, agent);
    try { await access(candidate, constants.X_OK); file = candidate; break; } catch { /* next PATH entry */ }
  }
  if (!file) return { version: null, installation: "missing" };
  try {
    const output = await command(file, ["--version"], environment(agent, home), 10_000);
    const version = output.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/)?.[0] ?? null;
    const target = await realpath(file);
    const nativeRoot = agent === "claude" ? join(homedir(), ".local", "share", "claude", "versions") : join(home, "packages", "standalone");
    const native = target.startsWith(`${nativeRoot}${sep}`) && version !== null;
    return { version, installation: native ? "native" : "external", command: file };
  } catch { return { version: null, installation: "unavailable" }; }
}

export async function latestAgentRelease(agent: AgentKind): Promise<string> {
  const url = agent === "codex" ? "https://releases.openai.com/codex/channels/latest"
    : "https://downloads.claude.ai/claude-code-releases/latest";
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "error" });
  if (!response.ok) throw new Error("Release lookup failed");
  const body = await response.text();
  if (body.length > 2_000_000) throw new Error("Release response too large");
  const value: unknown = agent === "codex" ? JSON.parse(body).tag_name?.replace(/^rust-v/, "") : body.trim();
  if (typeof value !== "string" || !versionPattern.test(value)) throw new Error("Release version unavailable");
  return value;
}


export function nativeInstallationDependencies(dataDir?: string): AgentInstallationHost {
  return {
    inspect: inspectAgentInstallation, latest: latestAgentRelease, now: Date.now, lock: () => () => {},
    update: async (agent, home, installed) => { await command(installed.command!, ["update"], environment(agent, home), 300_000); },
    readUpdates() {
      if (!dataDir) return {};
      try { return UpdateRecords.parse(JSON.parse(readFileSync(join(dataDir, "agent-updates.json"), "utf8"))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
    },
    writeUpdates(records) { if (dataDir) writePrivateFileAtomic(join(dataDir, "agent-updates.json"), JSON.stringify(records) + "\n"); },
  };
}
