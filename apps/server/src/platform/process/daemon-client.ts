import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { DAEMON_PROTOCOL, DaemonRequestSchema, type DaemonRequest } from "@palmagent/shared/daemon";

const MAX_FRAME = 65_536;

/** Match the native transport's canonical installation path and private socket. */
function controlSocket(dataDir: string): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Daemon transport requires a Unix installation owner");
  const hash = createHash("sha256").update(realpathSync(dataDir)).digest("hex").slice(0, 20);
  const directory = `/tmp/palmagentd-${uid}-${hash}`;
  const socket = join(directory, "control.sock");
  for (const path of [directory, socket]) {
    const stat = lstatSync(path);
    if (stat.uid !== uid || (stat.mode & 0o077) !== 0 ||
        (path === directory ? !stat.isDirectory() : !stat.isSocket())) {
      throw new Error("Daemon control endpoint must be private and owned by the installation user");
    }
  }
  return socket;
}

/**
 * Speak directly to the daemon. Never retry a request with unknown delivery.
 * Rust Request::control_timeout allows 90s for web restart; leave reply margin.
 */
export async function daemonRequest(
  dataDir: string, request: DaemonRequest,
  timeoutMs = request.action === "restart-web" ? 95_000 : 40_000,
): Promise<unknown> {
  const input = Buffer.from(JSON.stringify({ protocol: DAEMON_PROTOCOL, request: DaemonRequestSchema.parse(request) }) + "\n");
  if (input.length > MAX_FRAME) throw new Error("Daemon request is too large");
  const path = controlSocket(dataDir);
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let output = Buffer.alloc(0), settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("Daemon request timed out; delivery is unconfirmed")), timeoutMs);
    socket.once("connect", () => socket.write(input));
    socket.on("data", chunk => {
      output = Buffer.concat([output, chunk]);
      if (output.length > MAX_FRAME) { finish(new Error("Daemon response is too large")); return; }
      const end = output.indexOf(10);
      if (end < 0) return;
      try {
        const reply = JSON.parse(output.subarray(0, end).toString("utf8"));
        if (reply?.protocol !== DAEMON_PROTOCOL) throw new Error("Incompatible daemon protocol");
        if (reply.ok !== true) throw new Error("Palmagent daemon request failed; inspect private runtime logs");
        finish(undefined, reply.result);
      } catch (error) { finish(error instanceof Error ? error : new Error("Invalid daemon response")); }
    });
    socket.once("error", () => finish(new Error("Daemon connection failed; delivery is unconfirmed")));
    socket.once("close", () => finish(new Error("Daemon connection closed before acknowledgment; delivery is unconfirmed")));
  });
}
