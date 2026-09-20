import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { userInfo } from "node:os";
import { createServer, createConnection, type Socket } from "node:net";
import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { spawn } from "node-pty";
import { ensurePrivateDirectory } from "../private-files.js";
import type { LocalChannel, LocalTransport, ShellResolver, TerminalDriver, TerminalSupervisor } from "./platform.js";
const exec = promisify(execFile);

export const linuxShell: ShellResolver = {
  diagnosticCommand(marker) {
    if (!/^[A-Za-z0-9_]+$/.test(marker)) throw new Error("Invalid diagnostic marker");
    return `command printf '\\n%s%s\\n' '${marker.slice(0, 15)}' '${marker.slice(15)}'\r`;
  },
  resolve() {
    const user = userInfo();
    const executable = user.shell && existsSync(user.shell) ? user.shell : "/bin/sh";
    // Service-only credentials are not copied into interactive shell environments.
    const env: Record<string, string> = { HOME: user.homedir, USER: user.username, LOGNAME: user.username,
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", TERM: "xterm-256color", LANG: process.env.LANG ?? "C.UTF-8" };
    return { executable, args: ["-l"], env };
  },
};
export const ptyDriver: TerminalDriver = {
  spawn(profile, cwd, cols, rows) {
    const child = spawn(profile.executable, profile.args, { cwd, cols, rows, env: profile.env, name: "xterm-256color" });
    return { write: data => child.write(data), resize: (c, r) => child.resize(c, r), terminate: () => child.kill(),
      pause: () => child.pause(), resume: () => child.resume(),
      onOutput: callback => { const sub = child.onData(callback); return () => sub.dispose(); },
      onExit: callback => { const sub = child.onExit(event => callback(event.exitCode)); return () => sub.dispose(); } };
  },
};
export function linuxSupervisor(enabled: boolean, installed = () =>
  existsSync("/usr/local/libexec/palmagent-terminal-control") && existsSync("/etc/systemd/system/palmagent-terminal@.service")): TerminalSupervisor {
  return {
    get capabilities() {
      const available = enabled && installed();
      return { available, persistent: available, ...(!available ? {
        reason: enabled ? "Terminal services are not installed. Run palmagent setup to repair this installation."
          : "Run palmagent setup on a package installation to enable terminals.",
      } : {}) };
    },
    async inspect() {
      const probeId = "00000000-0000-4000-8000-000000000000";
      const loaded = await exec("systemctl", ["show", "palmagent-terminal@" + probeId + ".service", "--property=LoadState", "--value"], { timeout: 3000 });
      if (loaded.stdout.trim() !== "loaded") throw new Error("Terminal service template is not loaded; run palmagent setup");
      try { await exec("sudo", ["-n", "-l", "/usr/local/libexec/palmagent-terminal-control", "start", probeId], { timeout: 3000 }); }
      catch { throw new Error("Terminal service permissions are unavailable; run palmagent setup as the installation owner"); }
    },
    async launch(record) {
      try { await exec("sudo", ["-n", "/usr/local/libexec/palmagent-terminal-control", "start", record.id], { timeout: 10_000 }); }
      catch { throw new Error("Terminal launch is unconfirmed. Check terminal status before retrying."); }
    },
    async terminate(record) {
      try { await exec("sudo", ["-n", "/usr/local/libexec/palmagent-terminal-control", "stop", record.id], { timeout: 10_000 }); }
      catch { throw new Error("Terminal termination could not be confirmed"); }
    },
    async alive(record) {
      const result = await exec("systemctl", ["show", "--property=ActiveState", "--value", "palmagent-terminal@" + record.id + ".service"], { timeout: 3000 });
      return !["inactive", "failed"].includes(result.stdout.trim());
    },
  };
}
function socketPath(directory: string, id: string): string {
  // Unix socket path limits apply even when the installation has a long path.
  // systemd and an attaching CLI may have different TMPDIR environments.
  const root = join("/tmp", "palmagent-term-" + process.getuid?.() + "-" + createHash("sha256").update(directory).digest("hex").slice(0, 12));
  if (existsSync(root)) {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error("Unsafe terminal socket directory");
  } else ensurePrivateDirectory(root);
  return join(root, id + ".sock");
}
export function jsonChannel(socket: Socket): LocalChannel {
  let buffer = "";
  let message: (value: unknown) => void = () => {};
  let closed: () => void = () => {};
  socket.setEncoding("utf8");
  socket.on("error", () => socket.destroy());
  socket.on("close", () => closed());
  socket.on("data", chunk => {
    buffer += chunk;
    if (buffer.length > 4_000_000) { socket.destroy(); return; }
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { message(JSON.parse(line)); } catch { socket.destroy(); return; }
    }
  });
  return { send(value) {
    if (socket.destroyed || socket.writableLength > 4_000_000) { socket.destroy(); return false; }
    socket.write(JSON.stringify(value) + "\n"); return true;
  }, close: () => socket.destroy(), onMessage: fn => { message = fn; }, onClose: fn => { closed = fn; } };
}
export const unixTransport: LocalTransport = {
  connect(directory, id) {
    return new Promise((resolve, reject) => {
      const path = socketPath(directory, id);
      const stat = lstatSync(path);
      if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error("Unsafe terminal socket");
      const socket = createConnection(path);
      const timer = setTimeout(() => socket.destroy(new Error("Terminal connection timed out")), 3000);
      socket.once("error", reject);
      socket.once("connect", () => { clearTimeout(timer); resolve(jsonChannel(socket)); });
      socket.once("close", () => clearTimeout(timer));
    });
  },
  async listen(directory, id, accept) {
    const path = socketPath(directory, id);
    // A terminal id is single-use; a live endpoint is never unlinked.
    if (existsSync(path)) throw new Error("Terminal endpoint already exists");
    const server = createServer(socket => accept(jsonChannel(socket)));
    const old = process.umask(0o077);
    try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); }); }
    finally { process.umask(old); }
    chmodSync(path, 0o600);
    return () => { server.close(); try { unlinkSync(path); } catch { /* Already removed. */ } };
  },
};
