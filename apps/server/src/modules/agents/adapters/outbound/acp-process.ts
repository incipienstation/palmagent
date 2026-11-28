import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";

export interface AcpBridge { command: string; argv: string[] }

/** Each retained turn owns a process group containing its bridge and provider CLI. */
export function startAcpProcess(bridge: AcpBridge, cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(bridge.command, bridge.argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32" });
  child.stderr.resume();
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  function terminate(signal: NodeJS.Signals) {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch { /* The process group has exited. */ }
  }
  return {
    stream: ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),
    onError(callback: (error: Error) => void) {
      child.once("error", callback);
      child.stdin.on("error", callback);
    },
    async close() {
      child.stdin.end();
      terminate("SIGTERM");
      const kill = setTimeout(() => terminate("SIGKILL"), 2000);
      try { await exited; } finally { clearTimeout(kill); }
    },
  };
}
