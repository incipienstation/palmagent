import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import type { AgentKind, DispatchSessionRequest } from "@palmagent/shared";
import { localSessionRequest } from "./session-control.js";

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

const sessionHelp = `Usage:
  palmagent session dispatch --agent claude|codex [--session-id ID] [--wait-pid PID]
  palmagent session attach-image --agent claude|codex [--session-id ID] --file PATH

Use --cwd PATH for the session's working directory. Dispatch accepts --data-dir PATH.
Image delivery prints a Markdown image link for the task response.`;

export async function sessionCommand(argv: string[], environment: {
  resolveDataDir(path?: string): string;
  loadConfig(options: { dataDir: string; requireInstalled?: boolean }): { dbPath: string };
  stageImageFile(session: Omit<DispatchSessionRequest, "waitPid">, path: string): { path: string };
}): Promise<void> {
  const { resolveDataDir, loadConfig } = environment;
  const [command, ...args] = argv;
  if (command === "--help" || command === "-h" || args.includes("--help") || args.includes("-h")) { console.log(sessionHelp); return; }
  if (command !== "dispatch" && command !== "attach-image") throw new Error(sessionHelp);
  const { values } = parseArgs({ args, strict: true, options: {
    agent: { type: "string" }, "session-id": { type: "string" }, cwd: { type: "string" },
    "wait-pid": { type: "string" }, "data-dir": { type: "string" }, file: { type: "string" },
  } });
  if (command === "attach-image" && (!values.file || values["wait-pid"] !== undefined || values["data-dir"] !== undefined)) throw new Error(sessionHelp);
  if (command === "dispatch" && values.file !== undefined) throw new Error(sessionHelp);
  if (values.agent !== "claude" && values.agent !== "codex") throw new Error("--agent must be claude or codex");
  const agent: AgentKind = values.agent;
  const activeSession = agent === "codex" ? process.env.CODEX_THREAD_ID : process.env.CLAUDE_SESSION_ID;
  const sessionId = values["session-id"] ?? activeSession;
  if (command === "attach-image" && activeSession && sessionId !== activeSession) throw new Error("Image delivery must use the current native session");
  if (!sessionId) throw new Error("--session-id is required when the CLI does not expose its session identity");
  const home = agent === "claude" ? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude") : process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const session = { agent, sessionId, cwd: resolve(values.cwd ?? process.cwd()), home: resolve(home) };
  if (command === "attach-image") {
    const path = resolve(values.file!);
    const staged = environment.stageImageFile(session, path);
    console.log(`![Delivered image](sandbox:${staged.path})`);
    return;
  }
  const dataDir = resolveDataDir(values["data-dir"]);
  const socketDir = !values["data-dir"] && process.env.PALMAGENT_SESSION_SOCKET_DIR
    ? resolve(process.env.PALMAGENT_SESSION_SOCKET_DIR) : dirname(loadConfig({ dataDir }).dbPath);
  const result = await localSessionRequest(socketDir, { ...session, waitPid: values["wait-pid"] ? Number(values["wait-pid"]) : findAgentParent(agent) });
  if (result.task.sessionControl?.owner === "shared" && result.task.sessionControl.connection === "connected") {
    console.log(`Session connected as ${result.task.taskId}. Continue in Palmagent or this terminal; both use the same Codex session. You can leave the CLI open.`);
  } else if (result.task.sessionControl?.owner === "shared") {
    console.log(`Session reconnecting as ${result.task.taskId}. Palmagent is reconnecting to the existing Codex session. Keep this CLI open; browser input will resume after the connection is restored.`);
    if (result.task.sessionControl.error) console.log(result.task.sessionControl.error);
  } else {
    console.log(`Session queued as ${result.task.taskId}. Saved messages are available in Palmagent. This CLI session does not expose a shared connection; follow-up becomes available after the local writer exits and synchronization completes.`);
    if (result.task.sessionControl?.error) console.log(result.task.sessionControl.error);
  }
}
