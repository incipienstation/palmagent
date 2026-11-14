import { parseArgs } from "node:util";
import { dirname } from "node:path";
import { lstatSync } from "node:fs";
import { request } from "node:http";
import { sessionSocket } from "../../../../platform/ipc/session-socket.js";

const help = "Usage: palmagent view status|restart [--data-dir <path>]\n\nInspect or restart PWA file serving while the API, Task queues and live connections remain running.\nRun as the installation owner. Full application updates retain their maintenance rules.";

export async function viewCommand(args: string[], environment: {
  resolveDataDir(path?: string): string;
  loadConfig(options: { dataDir: string }): { dbPath: string };
}) {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true,
    options: { "data-dir": { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (values.help) { console.log(help); return; }
  const [action] = positionals;
  if (positionals.length !== 1 || !["status", "restart"].includes(action)) throw new Error(help);
  const cfg = environment.loadConfig({ dataDir: environment.resolveDataDir(values["data-dir"]) });
  const socket = sessionSocket(dirname(cfg.dbPath));
  const stat = lstatSync(socket);
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("Local control socket must be private and owned by this account");
  const result = await new Promise<unknown>((resolve, reject) => {
    const req = request({ socketPath: socket, path: action === "restart" ? "/view/restart" : "/view",
      method: action === "restart" ? "POST" : "GET", timeout: 20_000 }, response => {
      let text = "";
      response.on("data", chunk => { text += chunk; if (text.length > 16_384) req.destroy(new Error("View control response too large")); });
      response.on("error", reject);
      response.on("end", () => {
        if (response.statusCode === 404) { reject(new Error("This runtime does not support separate view hosting; update it first")); return; }
        try {
          const value = JSON.parse(text);
          if (response.statusCode !== 200) throw new Error(value.error ?? "View control failed");
          if (value.protocol !== 1) throw new Error("Unsupported view control protocol");
          resolve(value);
        } catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("View control timed out; inspect view status before retrying")));
    req.end();
  });
  console.log(JSON.stringify(result));
}
