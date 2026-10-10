import { spawnSync } from "node:child_process";
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
