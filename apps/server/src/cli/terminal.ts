import { parseArgs } from "node:util";
import { request } from "node:http";
import { lstatSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { TerminalId, terminalInputChunks, type TerminalFrame } from "@palmagent/shared/terminals";
import { resolveDataDir, loadConfig } from "./config.js";
import { sessionSocket } from "../session-control.js";
import { terminalPlatform } from "../terminal/adapters.js";
import { StringDecoder } from "node:string_decoder";
import { ViewerOutput } from "../terminal/viewer-output.js";

export const terminalHelp = `Usage: palmagent terminal <command> [options]

  list                              List terminals
  create --task <id> | --repo <id>   Open a shell in a Task or Space
  attach <id>                       Attach interactively (Ctrl+] detaches)
  rename <id> --title <name>         Rename a terminal
  terminate <id>                    End shell and its child processes

Options:
  --data-dir <path>   Installation state directory
  --request-id <id>   Idempotent creation request UUID
  --title <name>     Terminal title
  --help            Show this help

Run as the installation owner. Attach takes input control from other viewers.
Closing an attachment leaves the terminal running.`;

export async function terminalCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    "data-dir": { type: "string" }, task: { type: "string" }, repo: { type: "string" }, title: { type: "string" },
    "request-id": { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) { console.log(terminalHelp); return; }
  const [action, id] = positionals;
  if (positionals.length > 2 || !["list", "create", "attach", "rename", "terminate"].includes(action)) throw new Error(terminalHelp);
  const directory = resolveDataDir(values["data-dir"]);
  // Respect a custom application database's local control socket location.
  const cfg = loadConfig({ dataDir: directory, requireInstalled: true });
  const { dirname } = await import("node:path");
  const path = sessionSocket(dirname(cfg.dbPath ?? join(directory, "palmagent.db")));
  if (action === "attach") {
    TerminalId.parse(id);
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Attach requires an interactive terminal");
    const channel = await terminalPlatform(true).transport.connect(join(directory, "terminals"), id);
    let epoch = 0, writable = false;
    const resize = () => { if (writable) channel.send({ type: "resize", epoch, cols: Math.min(500, process.stdout.columns || 80), rows: Math.min(200, process.stdout.rows || 24) }); };
    const decoder = new StringDecoder("utf8");
    const output = new ViewerOutput();
    const input = (data: Buffer) => {
      if (data.includes(0x1d)) { channel.close(); return; }
      const decoded = decoder.write(data);
      if (writable) for (const chunk of terminalInputChunks(decoded)) channel.send({ type: "input", epoch, data: chunk });
    };
    await new Promise<void>(resolve => {
      const previousRaw = process.stdin.isRaw;
      process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("data", input); process.stdout.on("resize", resize);
      const detach = () => channel.close();
      process.once("SIGTERM", detach); process.once("SIGHUP", detach);
      channel.onClose(() => {
        process.off("SIGTERM", detach); process.off("SIGHUP", detach);
        process.stdin.off("data", input); process.stdout.off("resize", resize);
        process.stdin.setRawMode(previousRaw); process.stdin.pause();
        process.stdout.write("\x1b[?1049l\x1b[0m\r\nDetached.\r\n"); resolve();
      });
      channel.onMessage(value => {
        const frame = value as TerminalFrame;
        if (frame.type === "snapshot") {
          // Screen restoration is output only; terminal replies are handled by the host.
          process.stdout.write("\x1b[2J\x1b[H" + output.write(frame.data));
          channel.send({ type: "ack", seq: frame.seq }); channel.send({ type: "claim-control" });
        } else if (frame.type === "output") {
          process.stdout.write(output.write(frame.data), () => channel.send({ type: "ack", seq: frame.seq }));
        } else if (frame.type === "resize") channel.send({ type: "ack", seq: frame.seq });
        else if (frame.type === "control") { epoch = frame.epoch; writable = frame.writable; if (writable) resize(); }
        else if (frame.type === "exit") channel.close();
      });
    });
    return;
  }
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error("Unsafe installation control socket");
  let route = "/terminals", method = "GET", body: unknown;
  if (action === "create") {
    if (id || Boolean(values.task) === Boolean(values.repo)) throw new Error(terminalHelp);
    method = "POST"; body = { target: values.task ? { taskId: values.task } : { repoId: values.repo },
      requestId: values["request-id"] ?? randomUUID(), title: values.title, cols: 80, rows: 24 };
  } else if (action === "rename" || action === "terminate") {
    TerminalId.parse(id); route += "/" + id + (action === "terminate" ? "/terminate" : "");
    method = action === "rename" ? "PATCH" : "POST"; body = action === "rename" ? { title: values.title } : {};
  } else if (id) throw new Error(terminalHelp);
  const result = await new Promise<unknown>((resolve, reject) => {
    const req = request({ socketPath: path, path: route, method, headers: { "content-type": "application/json" }, timeout: 15_000 }, res => {
      let data = "";
      res.on("data", chunk => { data += chunk; if (data.length > 1_000_000) req.destroy(new Error("Response too large")); });
      res.on("end", () => { try { const value = JSON.parse(data); if ((res.statusCode ?? 500) >= 400) reject(new Error(value.error)); else resolve(value); } catch (error) { reject(error); } });
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("Terminal request timed out")));
    req.end(body ? JSON.stringify(body) : undefined);
  });
  console.log(JSON.stringify(result, null, 2));
}
