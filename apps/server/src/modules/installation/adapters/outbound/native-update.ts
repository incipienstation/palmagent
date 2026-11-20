import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { StandaloneUpdate } from "../../application/ports/outbound/standalone-update.js";
import { daemonBinary } from "./daemon-runtime.js";

export function updateBinary(directory?: string): string | undefined {
  if (!directory) return;
  const contract = join(directory, "runtime-contract.json");
  if (!existsSync(contract)) return;
  const version = JSON.parse(readFileSync(contract, "utf8")).standaloneUpdate;
  if (version === undefined) return;
  if (version !== 1) throw new Error("Incompatible standalone update protocol");
  return join(dirname(daemonBinary(directory, process.platform, process.arch, true)), "palmagent-runtime");
}

export function standaloneExecutor(directory?: string): StandaloneUpdate | undefined {
  const binary = updateBinary(directory);
  if (!binary) return;
  return async (request, effect) => {
    const child = spawn(binary, ["standalone-update"], { stdio: ["pipe", "pipe", "inherit"] });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    // A native exit during a host effect closes stdin. The close status is
    // authoritative, including when the peer disappears before the first frame.
    void exited.catch(() => {});
    child.stdin.on("error", () => {});
    const input = createInterface({ input: child.stdout });
    const reply = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
    try {
      reply(request);
      let done: boolean | undefined;
      for await (const line of input) {
        const command = JSON.parse(line);
        if (typeof command.error === "string") throw new Error(command.error);
        if (typeof command.done === "boolean") { done = command.done; break; }
        const start = performance.now();
        try { reply({ value: (await effect(command)) ?? null }); }
        catch (error) { reply({ error: (error instanceof Error ? error.message : String(error)).slice(0, 4096) }); }
        finally { console.error(`[update] ${command.op} ${Math.round(performance.now() - start)}ms`); }
      }
      if (await exited !== 0 || done === undefined) throw new Error("Standalone update worker stopped before confirming the outcome");
      return done;
    } finally {
      input.close(); child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
  };
}
