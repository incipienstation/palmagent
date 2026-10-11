import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { DaemonRequestSchema, type DaemonRequest } from "@palmagent/shared/daemon";

/** The stable private launcher speaks the versioned local protocol. Never falls back to sudo. */
export function daemonRequest(dataDir: string, request: DaemonRequest): unknown {
  const input = JSON.stringify(DaemonRequestSchema.parse(request));
  const result = spawnSync(join(dataDir, "daemon", "launcher"), ["request", "--data-dir", dataDir], {
    input, encoding: "utf8", timeout: 40_000, maxBuffer: 128 * 1024,
  });
  if (result.status !== 0) throw new Error("Palmagent daemon request failed; inspect daemon status and private runtime logs");
  return JSON.parse(result.stdout);
}

/** Async requests keep host reconciliation from blocking HTTP and provider event delivery. */
export function daemonRequestAsync(dataDir: string, request: DaemonRequest): Promise<unknown> {
  const input = JSON.stringify(DaemonRequestSchema.parse(request));
  return new Promise((resolve, reject) => {
    const child = spawn(join(dataDir, "daemon", "launcher"), ["request", "--data-dir", dataDir], { stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 40_000);
    child.stdin.on("error", () => {});
    child.stdout.on("data", chunk => { output += chunk.toString(); if (output.length > 128 * 1024) child.kill("SIGKILL"); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error("Palmagent daemon request failed; inspect daemon status and private runtime logs")); return; }
      try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
    });
    child.stdin.end(input);
  });
}
