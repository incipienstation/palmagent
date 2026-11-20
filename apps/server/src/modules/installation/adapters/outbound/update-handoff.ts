import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DaemonConfigurationSchema } from "@palmagent/shared/daemon";
import { connectionInfo } from "./connection.js";
import { releaseContract } from "./execution-release.js";
import type { InstallConfig } from "../../domain/installation.js";

/** Both packages opt into the same writable Task/inbox formats. Existing installs
 * adopt the reusable listener on their first normal maintenance activation. */
export function handoffCompatibility(previous: InstallConfig, candidate: InstallConfig) {
  if (!previous.pkgDir || !previous.executionNode || !candidate.pkgDir) return { live: false, rollback: false };
  const old = releaseContract(previous.pkgDir), next = releaseContract(candidate.pkgDir);
  const rollback = (old.taskStorage ?? 1) === (next.taskStorage ?? 1);
  return { rollback, live: rollback && previous.supervisor === "palmagentd" && old.updateAdmission === 1 && next.updateAdmission === 1 };
}

export async function openUpdateGateway(cfg: InstallConfig, candidate: InstallConfig): Promise<() => Promise<void>> {
  const daemon = DaemonConfigurationSchema.parse(JSON.parse(readFileSync(join(cfg.dataDir, "daemon/config.json"), "utf8")));
  if (![cfg.pkgDir, candidate.pkgDir].includes(daemon.release) || daemon.environment.DISPATCHER_DB !== cfg.dbPath ||
      daemon.environment.HOST !== cfg.host || daemon.environment.DISPATCHER_DATA_DIR !== cfg.dataDir ||
      daemon.environment.PORT !== String(cfg.port) || daemon.environment.AUTH_ORIGIN !== cfg.authOrigin)
    throw new Error("Running installation differs from the update gateway configuration");
  const response = await fetch(connectionInfo(cfg).upstream + "/api/health", { headers: { connection: "close" }, signal: AbortSignal.timeout(5000), redirect: "error" });
  const health = await response.json() as { ok?: boolean; updateAdmission?: number; build?: { sourceCommit?: string; version?: string } };
  const retainedBuild = (directory: string) => JSON.parse(readFileSync(join(directory, "build-info.json"), "utf8"));
  if (!response.ok || !health.ok || health.updateAdmission !== 1 ||
      ![cfg.pkgDir!, candidate.pkgDir!].map(retainedBuild).some(build => build.version === health.build?.version && build.sourceCommit === health.build?.sourceCommit))
    throw new Error("Live Task owner does not match the handoff release pair");
  const child = spawn(cfg.executionNode!, [join(cfg.pkgDir!, "update-gateway.js")], {
    cwd: cfg.pkgDir, env: daemon.environment, stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const ended = new Promise<void>(resolve => child.once("close", () => resolve()));
  const stop = async () => {
    if (child.connected) child.disconnect();
    const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
    try { await ended; } finally { clearTimeout(kill); }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => done(new Error("Update gateway readiness timed out")), 10000);
      function done(error?: Error) {
        clearTimeout(deadline);
        child.off("message", ready); child.off("exit", exited); child.off("error", done);
        if (error) reject(error); else resolve();
      }
      function ready(value: unknown) { if (value && typeof value === "object" && "ready" in value && value.ready === 1) done(); }
      function exited() { done(new Error("Update gateway exited before readiness")); }
      child.on("message", ready); child.once("exit", exited); child.once("error", done);
    });
    return stop;
  } catch (error) { await stop(); throw error; }
}
