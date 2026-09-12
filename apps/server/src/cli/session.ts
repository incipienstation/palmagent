import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import type { AgentKind } from "@palmagent/shared";
import { localSessionRequest } from "../session-control.js";
import { loadConfig, resolveDataDir } from "./config.js";

export function findAgentParent(agent: AgentKind, initial = process.ppid): number {
  let pid = initial;
  for (let depth = 0; pid > 1 && depth < 32; depth++) {
    const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    if (args.slice(0, 2).some((arg) => basename(arg) === agent || basename(arg) === `${agent}.js`)) return pid;
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  }
  throw new Error("Run dispatch from the active agent session, or supply its --wait-pid explicitly");
}

export async function sessionCommand(argv: string[]): Promise<void> {
  if (argv[0] !== "dispatch") throw new Error("usage: palmagent session dispatch --agent claude|codex --session-id ID [--cwd PATH] [--wait-pid PID] [--data-dir PATH]");
  const { values } = parseArgs({ args: argv.slice(1), strict: true, options: {
    agent: { type: "string" }, "session-id": { type: "string" }, cwd: { type: "string" },
    "wait-pid": { type: "string" }, "data-dir": { type: "string" },
  } });
  if (values.agent !== "claude" && values.agent !== "codex") throw new Error("--agent must be claude or codex");
  const agent = values.agent;
  const sessionId = values["session-id"] ?? (agent === "codex" ? process.env.CODEX_THREAD_ID : process.env.CLAUDE_SESSION_ID);
  if (!sessionId) throw new Error("--session-id is required when the CLI does not expose its session identity");
  const home = agent === "claude" ? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude") : process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const dataDir = resolveDataDir(values["data-dir"]);
  const socketDir = !values["data-dir"] && process.env.PALMAGENT_SESSION_SOCKET_DIR
    ? resolve(process.env.PALMAGENT_SESSION_SOCKET_DIR) : dirname(loadConfig({ dataDir }).dbPath);
  const result = await localSessionRequest(socketDir, { agent, sessionId, cwd: resolve(values.cwd ?? process.cwd()), home: resolve(home), waitPid: values["wait-pid"] ? Number(values["wait-pid"]) : findAgentParent(agent) });
  console.log(`Session queued as ${result.task.taskId}. Close this local agent CLI to finish transfer. Palmagent will synchronize its transcript before enabling follow-up.`);
}
