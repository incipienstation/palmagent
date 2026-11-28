import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { attachmentUrl, INPUT_IMAGE_POLICY, type AgentKind } from "@palmagent/shared";
import { rasterMediaType } from "../../application/attachments/output-images.js";
import { deliverLocalImage, localSessionRequest } from "./session-control.js";

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

Both commands accept --cwd PATH and --data-dir PATH. Image delivery prints a Markdown
image link and registers the original absolute path with the current session's task.`;

function readDeliveryImage(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd), size = stat.size;
    if (!stat.isFile() || size > INPUT_IMAGE_POLICY.maxBytes) throw new Error("Image must be a regular file of at most 4.5 MiB");
    const bytes = Buffer.alloc(size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== size) throw new Error("Image changed during delivery");
    const content = bytes.subarray(0, length);
    const mediaType = rasterMediaType(content);
    if (!mediaType) throw new Error("Image delivery supports PNG, JPEG, GIF and WebP");
    return { mediaType, data: content.toString("base64") };
  } finally { closeSync(fd); }
}

export async function sessionCommand(argv: string[], environment: { resolveDataDir(path?: string): string; loadConfig(options: { dataDir: string; requireInstalled?: boolean }): { dbPath: string } }): Promise<void> {
  const { resolveDataDir, loadConfig } = environment;
  const [command, ...args] = argv;
  if (command === "--help" || command === "-h" || args.includes("--help") || args.includes("-h")) { console.log(sessionHelp); return; }
  if (command !== "dispatch" && command !== "attach-image") throw new Error(sessionHelp);
  const { values } = parseArgs({ args, strict: true, options: {
    agent: { type: "string" }, "session-id": { type: "string" }, cwd: { type: "string" },
    "wait-pid": { type: "string" }, "data-dir": { type: "string" }, file: { type: "string" },
  } });
  if (command === "attach-image" && (!values.file || values["wait-pid"] !== undefined)) throw new Error(sessionHelp);
  if (command === "dispatch" && values.file !== undefined) throw new Error(sessionHelp);
  if (values.agent !== "claude" && values.agent !== "codex") throw new Error("--agent must be claude or codex");
  const agent: AgentKind = values.agent;
  const activeSession = agent === "codex" ? process.env.CODEX_THREAD_ID : process.env.CLAUDE_SESSION_ID;
  const sessionId = values["session-id"] ?? activeSession;
  if (command === "attach-image" && activeSession && sessionId !== activeSession) throw new Error("Image delivery must use the current native session");
  if (!sessionId) throw new Error("--session-id is required when the CLI does not expose its session identity");
  const home = agent === "claude" ? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude") : process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const dataDir = resolveDataDir(values["data-dir"]);
  const socketDir = !values["data-dir"] && process.env.PALMAGENT_SESSION_SOCKET_DIR
    ? resolve(process.env.PALMAGENT_SESSION_SOCKET_DIR) : dirname(loadConfig({ dataDir }).dbPath);
  const session = { agent, sessionId, cwd: resolve(values.cwd ?? process.cwd()), home: resolve(home) };
  if (command === "attach-image") {
    const path = resolve(values.file!);
    const { taskId, attachmentId } = await deliverLocalImage(socketDir, { ...session, path, image: readDeliveryImage(path) });
    console.log(`![Delivered image](${attachmentUrl(taskId, attachmentId)})`);
    return;
  }
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
